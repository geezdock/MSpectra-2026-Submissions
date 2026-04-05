import React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Camera, Mic, PhoneCall, PhoneOff, Video } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../../contexts/AuthContext';
import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import api from '../../lib/axios';

const buildTranscriptFromTurns = (turns) =>
  (turns || [])
    .filter((turn) => turn?.speaker && turn?.text)
    .map((turn, index) => `${index + 1}. ${turn.speaker.toUpperCase()}: ${turn.text}`)
    .join('\n');

const resolveAiOutputMode = (value) => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'openai_stream') {
    return 'openai_stream';
  }
  return 'browser_tts';
};

const DEFAULT_AI_OUTPUT_MODE = resolveAiOutputMode(import.meta.env.VITE_AI_INTERVIEW_OUTPUT_MODE);
const DEFAULT_MAX_REALTIME_QUESTIONS = 6;
const VOICE_SILENCE_AUTO_STOP_MS = 2500;

const normalizeTranscriptText = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

const parseRealtimeQuestionOrdinal = (text) => {
  const normalized = normalizeTranscriptText(text);
  if (!normalized) {
    return null;
  }

  const prefixedMatch = normalized.match(/^Q\s*(\d+)\s*\//i);
  if (prefixedMatch) {
    return Number(prefixedMatch[1]);
  }

  if (normalized.endsWith('?')) {
    return -1;
  }

  return null;
};

const uploadBlobToSignedUrl = async (blob, sessionId, fileType = 'video', extension = 'webm') => {
  const response = await api.post('/candidate/storage/signed-interview-upload', {
    sessionId,
    fileType,
    extension,
  });
  const signedUrl = response.data?.signedUrl;
  const path = response.data?.path;
  const uploadNonce = response.data?.uploadNonce;
  if (!signedUrl) {
    throw new Error('Unable to prepare interview media upload');
  }
  if (!path || !uploadNonce) {
    throw new Error('Upload authorization is incomplete');
  }

  const uploadResponse = await fetch(signedUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'video/webm',
      'x-upsert': 'false',
    },
    body: blob,
  });

  if (!uploadResponse.ok) {
    throw new Error('Failed to upload interview recording');
  }

  return {
    path,
    uploadNonce,
  };
};

export default function Interview() {
  const navigate = useNavigate();
  const location = useLocation();
  const { interviewLock, startInterviewLock, clearInterviewLock } = useAuth();
  const [sessionData, setSessionData] = useState(null);
  const [aiOutputMode, setAiOutputMode] = useState(DEFAULT_AI_OUTPUT_MODE);
  const [interviewRole, setInterviewRole] = useState('General Candidate');
  const [interviewPlan, setInterviewPlan] = useState(null);
  const [resumeSummary, setResumeSummary] = useState('');

  const [hasAcknowledgedNotice, setHasAcknowledgedNotice] = useState(false);
  const [startingSession, setStartingSession] = useState(false);
  const [connecting, setConnecting] = useState(true);
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [responses, setResponses] = useState([]);
  const [transcriptTurns, setTranscriptTurns] = useState([]);
  const [autosavingTranscript, setAutosavingTranscript] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState('idle');
  const [completing, setCompleting] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [questionsAsked, setQuestionsAsked] = useState(0);
  const [awaitingCandidateReply, setAwaitingCandidateReply] = useState(false);
  const [interviewCompleteReason, setInterviewCompleteReason] = useState('');
  const [loadingGroqQuestion, setLoadingGroqQuestion] = useState(false);
  const [speechRecognitionSupported, setSpeechRecognitionSupported] = useState(false);
  const [capturingVoiceAnswer, setCapturingVoiceAnswer] = useState(false);
  const [submittingGroqTurn, setSubmittingGroqTurn] = useState(false);
  const [speakingAiResponse, setSpeakingAiResponse] = useState(false);
  const [groqDebugTimestamps, setGroqDebugTimestamps] = useState({
    lastListenStart: null,
    lastSubmit: null,
    lastSpeakEnd: null,
  });

  const videoRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const rtcPeerConnectionRef = useRef(null);
  const rtcDataChannelRef = useRef(null);
  const realtimeInitRef = useRef(false);
  const realtimeModelRef = useRef('gpt-4o-realtime-preview-2024-12-17');
  const realtimeConnectedRef = useRef(false);
  const lastRealtimeAiTextRef = useRef('');
  const lastRealtimeCandidateTextRef = useRef('');
  const recordedChunksRef = useRef([]);
  const transcriptTurnsRef = useRef([]);
  const autosaveInFlightRef = useRef(false);
  const autosaveQueuedRef = useRef(false);
  const lastAutosavedTranscriptRef = useRef('');
  const lastRequestedTranscriptVersionRef = useRef(0);
  const lastAppliedTranscriptVersionRef = useRef(0);
  const sessionFinalizedRef = useRef(false);
  const questionsAskedRef = useRef(0);
  const awaitingCandidateReplyRef = useRef(false);
  const autoCompletingRef = useRef(false);
  const lastStartInterviewErrorRef = useRef({ message: '', at: 0 });
  const startInterviewProviderErrorShownRef = useRef(false);
  const speechRecognitionRef = useRef(null);
  const speechFinalBufferRef = useRef('');
  const speechSilenceTimerRef = useRef(null);
  const skipNextSpeechSubmitRef = useRef(false);
  const groqTurnInFlightRef = useRef(false);
  const groqAutoKickoffDoneRef = useRef(false);
  const startVoiceAnswerCaptureRef = useRef(() => {});

  const questions = useMemo(() => interviewPlan?.questions ?? [], [interviewPlan]);
  const maxRealtimeQuestions = useMemo(() => {
    const configured = sessionData?.interviewPlan?.realtime?.maxQuestions;
    if (Number.isInteger(configured) && configured > 0) {
      return configured;
    }
    return DEFAULT_MAX_REALTIME_QUESTIONS;
  }, [sessionData?.interviewPlan?.realtime?.maxQuestions]);
  const activeQuestion = questions[activeQuestionIndex] ?? null;
  const routeSessionId = location.state?.sessionData?.session?.id || null;
  const isLiveInterviewRoute = location.pathname === '/interview/live';
  const transcriptSnapshot = useMemo(() => buildTranscriptFromTurns(transcriptTurns), [transcriptTurns]);
  const usesGroqPlan = useMemo(() => {
    const voiceProvider = sessionData?.interviewPlan?.realtime?.voiceProvider;
    return voiceProvider === 'groq_browser';
  }, [sessionData?.interviewPlan?.realtime?.voiceProvider]);
  const useGroqVoiceMode = useMemo(() => {
    return usesGroqPlan;
  }, [usesGroqPlan]);

  const groqAutoFlowStatus = useMemo(() => {
    if (!useGroqVoiceMode) {
      return null;
    }

    if (submittingGroqTurn || loadingGroqQuestion) {
      return 'submitting';
    }

    if (speakingAiResponse) {
      return 'speaking';
    }

    if (capturingVoiceAnswer) {
      return 'listening';
    }

    return 'waiting';
  }, [capturingVoiceAnswer, loadingGroqQuestion, speakingAiResponse, submittingGroqTurn, useGroqVoiceMode]);

  const groqAutoFlowStatusText = useMemo(() => {
    if (!groqAutoFlowStatus) {
      return '';
    }

    if (groqAutoFlowStatus === 'listening') {
      return 'Listening: capturing your answer now.';
    }

    if (groqAutoFlowStatus === 'submitting') {
      return 'Submitting: sending your answer and fetching the next question.';
    }

    if (groqAutoFlowStatus === 'speaking') {
      return 'Speaking: AI interviewer is reading the next question.';
    }

    return awaitingCandidateReply
      ? 'Waiting: ready for your response.'
      : 'Waiting: preparing the next interview step.';
  }, [awaitingCandidateReply, groqAutoFlowStatus]);

  const formatDebugTime = useCallback((value) => {
    if (!value) {
      return '--';
    }

    try {
      return new Date(value).toLocaleTimeString();
    } catch (_error) {
      return '--';
    }
  }, []);

  const speakText = useCallback((text, options = {}) => {
    const normalized = normalizeTranscriptText(text);
    if (!normalized || !window.speechSynthesis) {
      setSpeakingAiResponse(false);
      if (typeof options.onEnd === 'function') {
        options.onEnd();
      }
      return;
    }
    const utterance = new SpeechSynthesisUtterance(normalized);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onstart = () => {
      setSpeakingAiResponse(true);
    };
    utterance.onend = () => {
      setSpeakingAiResponse(false);
      setGroqDebugTimestamps((prev) => ({ ...prev, lastSpeakEnd: new Date().toISOString() }));
      if (typeof options.onEnd === 'function') {
        options.onEnd();
      }
    };
    utterance.onerror = () => {
      setSpeakingAiResponse(false);
      setGroqDebugTimestamps((prev) => ({ ...prev, lastSpeakEnd: new Date().toISOString() }));
      if (typeof options.onEnd === 'function') {
        options.onEnd();
      }
    };
    setSpeakingAiResponse(false);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, []);

  const clearSpeechSilenceTimer = useCallback(() => {
    if (speechSilenceTimerRef.current) {
      window.clearTimeout(speechSilenceTimerRef.current);
      speechSilenceTimerRef.current = null;
    }
  }, []);

  const stopVoiceAnswerCapture = useCallback((reason = 'manual', options = {}) => {
    if (options.skipSubmit) {
      skipNextSpeechSubmitRef.current = true;
    }

    clearSpeechSilenceTimer();

    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch (_error) {
        // no-op
      }
    }
    setCapturingVoiceAnswer(false);

    if (reason === 'silence') {
      toast('Voice capture paused after silence. You can start again if needed.');
    }
  }, [clearSpeechSilenceTimer]);

  useEffect(() => {
    transcriptTurnsRef.current = transcriptTurns;
  }, [transcriptTurns]);

  useEffect(() => {
    questionsAskedRef.current = questionsAsked;
  }, [questionsAsked]);

  useEffect(() => {
    awaitingCandidateReplyRef.current = awaitingCandidateReply;
  }, [awaitingCandidateReply]);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSpeechRecognitionSupported(typeof SpeechRecognition === 'function');

    return () => {
      clearSpeechSilenceTimer();
      if (speechRecognitionRef.current) {
        skipNextSpeechSubmitRef.current = true;
        try {
          speechRecognitionRef.current.stop();
        } catch (_error) {
          // no-op
        }
      }
    };
  }, [clearSpeechSilenceTimer]);

  const appendRealtimeTurn = useCallback((speaker, text, idPrefix) => {
    const normalizedText = normalizeTranscriptText(text);
    if (!normalizedText) {
      return;
    }

    setTranscriptTurns((prev) => [
      ...prev,
      {
        id: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        speaker,
        text: normalizedText,
        timestamp: new Date().toISOString(),
      },
    ]);
  }, []);

  const cleanupRealtimeTransport = useCallback(() => {
    realtimeConnectedRef.current = false;
    realtimeInitRef.current = false;

    if (rtcDataChannelRef.current) {
      try {
        rtcDataChannelRef.current.close();
      } catch (_error) {
        // no-op
      }
      rtcDataChannelRef.current = null;
    }

    if (rtcPeerConnectionRef.current) {
      try {
        rtcPeerConnectionRef.current.close();
      } catch (_error) {
        // no-op
      }
      rtcPeerConnectionRef.current = null;
    }

    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  }, []);

  const exitFullscreenSafely = useCallback(async () => {
    if (document.fullscreenElement && document.exitFullscreen) {
      try {
        await document.exitFullscreen();
      } catch (_error) {
        // no-op
      }
    }
  }, []);

  const buildRealtimeTurnPrompt = useCallback(
    (phase = 'followup') => {
      const jobContext = sessionData?.interviewPlan?.job_context || {};
      const flowTopics = Array.isArray(sessionData?.interviewPlan?.flow) ? sessionData.interviewPlan.flow.join(', ') : '';
      const requiredSkills = Array.isArray(jobContext?.required_skills) ? jobContext.required_skills.join(', ') : '';
      const responsibilities = Array.isArray(jobContext?.key_responsibilities) ? jobContext.key_responsibilities.join(', ') : '';
      const nextQuestionNumber = Math.min(maxRealtimeQuestions, questionsAskedRef.current + 1);

      return [
        `You are conducting a one-on-one live interview for role: ${sessionData?.interviewRole || interviewRole || 'General Candidate'}.`,
        `Ask exactly one concise question now, prefixed as Q${nextQuestionNumber}/${maxRealtimeQuestions}:.`,
        'Do not provide hints or model answers. Do not ask compound questions.',
        `Use resume context: ${resumeSummary || 'No resume summary available.'}`,
        `Use flow topics when relevant: ${flowTopics || 'General role fit and problem solving.'}`,
        `Use JD required skills when relevant: ${requiredSkills || 'Not provided.'}`,
        `Use JD responsibilities when relevant: ${responsibilities || 'Not provided.'}`,
        'Avoid repeating prior question topics from transcript history.',
        phase === 'initial' ? 'This is the first question of the interview.' : 'This is the next follow-up question based on the latest candidate response.',
      ].join(' ');
    },
    [interviewRole, maxRealtimeQuestions, resumeSummary, sessionData?.interviewPlan?.flow, sessionData?.interviewPlan?.job_context, sessionData?.interviewRole],
  );

  const sendRealtimeFollowupPrompt = useCallback((phase = 'followup') => {
    const channel = rtcDataChannelRef.current;
    if (!channel || channel.readyState !== 'open') {
      return false;
    }

    const prompt = {
      type: 'response.create',
      response: {
        modalities: ['audio', 'text'],
        instructions: buildRealtimeTurnPrompt(phase),
      },
    };

    channel.send(JSON.stringify(prompt));
    return true;
  }, [buildRealtimeTurnPrompt]);

  const handleRealtimeEvent = useCallback(
    (eventPayload) => {
      if (!eventPayload || typeof eventPayload !== 'object') {
        return;
      }

      if (eventPayload.type === 'error') {
        setRealtimeStatus('fallback');
        return;
      }

      if (eventPayload.type === 'response.audio_transcript.done' || eventPayload.type === 'response.output_text.done') {
        const aiText = normalizeTranscriptText(eventPayload.transcript || eventPayload.text || '');
        if (aiText && aiText !== lastRealtimeAiTextRef.current) {
          lastRealtimeAiTextRef.current = aiText;
          appendRealtimeTurn('ai', aiText, 'ai-realtime');

          if (aiText.includes('INTERVIEW_COMPLETE')) {
            if (!autoCompletingRef.current) {
              autoCompletingRef.current = true;
              setInterviewCompleteReason('question_limit_reached');
            }
            return;
          }

          const parsedQuestionOrdinal = parseRealtimeQuestionOrdinal(aiText);
          if (parsedQuestionOrdinal !== null) {
            setAwaitingCandidateReply(true);
            if (parsedQuestionOrdinal > 0) {
              setQuestionsAsked((prev) => Math.max(prev, parsedQuestionOrdinal));
            } else {
              setQuestionsAsked((prev) => prev + 1);
            }
          }
        }
      }

      if (eventPayload.type === 'conversation.item.input_audio_transcription.completed') {
        const candidateText = normalizeTranscriptText(eventPayload.transcript || '');
        if (candidateText && candidateText !== lastRealtimeCandidateTextRef.current) {
          lastRealtimeCandidateTextRef.current = candidateText;
          appendRealtimeTurn('candidate', candidateText, 'candidate-realtime');

          if (!awaitingCandidateReplyRef.current) {
            return;
          }

          setAwaitingCandidateReply(false);

          if (questionsAskedRef.current >= maxRealtimeQuestions) {
            if (!autoCompletingRef.current) {
              autoCompletingRef.current = true;
              setInterviewCompleteReason('question_limit_reached');
            }
            return;
          }

          window.setTimeout(() => {
            sendRealtimeFollowupPrompt('followup');
          }, 350);
        }
      }
    },
    [appendRealtimeTurn, maxRealtimeQuestions, sendRealtimeFollowupPrompt],
  );

  const startRealtimeTransport = useCallback(async () => {
    if (realtimeInitRef.current) {
      return;
    }
    if (!sessionData?.session?.id || !mediaStreamRef.current) {
      return;
    }

    realtimeInitRef.current = true;
    setRealtimeStatus('connecting');

    try {
      const tokenResponse = await api.post(`/candidate/interview-session/${sessionData.session.id}/realtime-token`);
      const realtimePayload = tokenResponse.data?.realtime;
      const ephemeralKey = realtimePayload?.clientSecret;
      const model = realtimePayload?.model || 'gpt-4o-realtime-preview-2024-12-17';
      const tokenMaxQuestions = realtimePayload?.maxQuestions;
      if (!ephemeralKey) {
        throw new Error('Realtime token unavailable');
      }

      if (Number.isInteger(tokenMaxQuestions) && tokenMaxQuestions > 0) {
        setSessionData((prev) => {
          if (!prev) {
            return prev;
          }
          return {
            ...prev,
            interviewPlan: {
              ...(prev.interviewPlan || {}),
              realtime: {
                ...((prev.interviewPlan || {}).realtime || {}),
                maxQuestions: tokenMaxQuestions,
              },
            },
          };
        });
      }

      realtimeModelRef.current = model;
      const peerConnection = new RTCPeerConnection();
      rtcPeerConnectionRef.current = peerConnection;

      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, mediaStreamRef.current);
      });

      peerConnection.ontrack = (event) => {
        const [remoteStream] = event.streams || [];
        if (remoteAudioRef.current && remoteStream) {
          remoteAudioRef.current.srcObject = remoteStream;
        }
      };

      const dataChannel = peerConnection.createDataChannel('oai-events');
      rtcDataChannelRef.current = dataChannel;

      dataChannel.onopen = () => {
        realtimeConnectedRef.current = true;
        setRealtimeStatus('connected');
        sendRealtimeFollowupPrompt('initial');
      };

      dataChannel.onmessage = (messageEvent) => {
        try {
          const parsed = JSON.parse(messageEvent.data);
          handleRealtimeEvent(parsed);
        } catch (_error) {
          // no-op
        }
      };

      dataChannel.onerror = () => {
        setRealtimeStatus('fallback');
      };

      dataChannel.onclose = () => {
        realtimeConnectedRef.current = false;
        if (!sessionFinalizedRef.current && !terminating && !completing) {
          setRealtimeStatus('fallback');
        }
      };

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${ephemeralKey}`,
          'Content-Type': 'application/sdp',
        },
      });

      if (!sdpResponse.ok) {
        throw new Error('Failed to connect realtime stream');
      }

      const answerSdp = await sdpResponse.text();
      await peerConnection.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp,
      });
    } catch (_error) {
      cleanupRealtimeTransport();
      setRealtimeStatus('fallback');
      toast.error('Realtime AI transport unavailable, using browser voice fallback');
    }
  }, [cleanupRealtimeTransport, completing, handleRealtimeEvent, sendRealtimeFollowupPrompt, sessionData?.session?.id, terminating]);

  const requestGroqNextQuestion = useCallback(async ({ candidateText = '' } = {}) => {
    if (!sessionData?.session?.id || loadingGroqQuestion || sessionFinalizedRef.current || groqTurnInFlightRef.current) {
      return;
    }

    try {
      groqTurnInFlightRef.current = true;
      setSubmittingGroqTurn(true);
      setGroqDebugTimestamps((prev) => ({ ...prev, lastSubmit: new Date().toISOString() }));
      setLoadingGroqQuestion(true);
      const normalizedCandidateText = normalizeTranscriptText(candidateText);
      let payloadTurns = transcriptTurnsRef.current;

      if (normalizedCandidateText) {
        const candidateTurnId = `candidate-groq-${Math.max(questionsAskedRef.current, 1)}`;
        const candidateTurn = {
          id: candidateTurnId,
          speaker: 'candidate',
          text: normalizedCandidateText,
          timestamp: new Date().toISOString(),
        };

        const existingIndex = payloadTurns.findIndex((turn) => turn?.id === candidateTurnId);
        const nextTurns = [...payloadTurns];
        if (existingIndex === -1) {
          nextTurns.push(candidateTurn);
        } else {
          nextTurns[existingIndex] = candidateTurn;
        }

        payloadTurns = nextTurns;
        transcriptTurnsRef.current = nextTurns;
        setTranscriptTurns(nextTurns);
      }

      const response = await api.post(`/candidate/interview-session/${sessionData.session.id}/next-question`, {
        transcriptTurns: payloadTurns,
        questionsAsked: questionsAskedRef.current,
      });

      const payload = response.data || {};
      const serverTranscriptVersion = Number.isInteger(payload.transcriptVersion)
        ? payload.transcriptVersion
        : null;
      if (serverTranscriptVersion !== null) {
        lastAppliedTranscriptVersionRef.current = Math.max(lastAppliedTranscriptVersionRef.current, serverTranscriptVersion);
        lastRequestedTranscriptVersionRef.current = Math.max(lastRequestedTranscriptVersionRef.current, serverTranscriptVersion);
      }

      if (payload.completed) {
        if (payload.autoCompleted) {
          sessionFinalizedRef.current = true;
          clearInterviewLock();
          await exitFullscreenSafely();
          if (payload.scoringStatus === 'pending') {
            toast.success('Interview completed. Scoring is queued and will appear shortly.');
          } else {
            toast.success('Interview completed and scoring has started.');
          }
          navigate('/candidate', { replace: true });
          return;
        }

        if (!autoCompletingRef.current) {
          autoCompletingRef.current = true;
          setInterviewCompleteReason('question_limit_reached');
        }
        return;
      }

      const questionText = normalizeTranscriptText(payload.question || '');
      if (!questionText) {
        throw new Error('Interviewer returned an empty question');
      }

      const questionNumber = Number.isInteger(payload.questionNumber)
        ? payload.questionNumber
        : questionsAskedRef.current + 1;

      setQuestionsAsked(questionNumber);
      setAwaitingCandidateReply(true);
      appendRealtimeTurn('ai', questionText, `ai-next-${questionNumber}`);
      speakText(questionText, {
        onEnd: () => {
          if (
            !useGroqVoiceMode ||
            sessionFinalizedRef.current ||
            groqTurnInFlightRef.current ||
            completing ||
            terminating
          ) {
            return;
          }

          window.setTimeout(() => {
            startVoiceAnswerCaptureRef.current?.();
          }, 200);
        },
      });
    } catch (error) {
      toast.error(error?.message || 'Unable to get next interview question');
    } finally {
      setLoadingGroqQuestion(false);
      setSubmittingGroqTurn(false);
      groqTurnInFlightRef.current = false;
    }
  }, [
    appendRealtimeTurn,
    clearInterviewLock,
    completing,
    exitFullscreenSafely,
    loadingGroqQuestion,
    navigate,
    sessionData?.session?.id,
    speakText,
    terminating,
    useGroqVoiceMode,
  ]);

  const terminateInterview = useCallback(
    async (reason) => {
      if (!sessionData?.session?.id || sessionFinalizedRef.current) {
        return;
      }

      try {
        setTerminating(true);
        sessionFinalizedRef.current = true;
        cleanupRealtimeTransport();

        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
        }
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        }

        await api.post(`/candidate/interview-session/${sessionData.session.id}/terminate`, {
          reason,
          transcript: transcriptSnapshot,
          durationSeconds: elapsedSeconds,
        });
      } catch (_error) {
        // best-effort termination
      } finally {
        clearInterviewLock();
        await exitFullscreenSafely();
        const terminationMessage =
          reason === 'route_leave'
            ? 'Interview session ended while leaving the interview page.'
            : 'Interview session terminated.';
        toast.error(terminationMessage);
        navigate('/candidate', { replace: true });
      }
    },
    [
      cleanupRealtimeTransport,
      clearInterviewLock,
      elapsedSeconds,
      exitFullscreenSafely,
      navigate,
      sessionData?.session?.id,
      transcriptSnapshot,
    ],
  );

  useEffect(() => {
    const fetchInterviewContext = async () => {
      try {
        const response = await api.get('/candidate/interview-slots');
        const plan = response.data?.interviewPlan;
        const latestSession = response.data?.latestSession;
        const sessionIdToValidate = routeSessionId || latestSession?.id || null;

        if (plan) {
          setInterviewPlan(plan);
          setInterviewRole(plan.role || 'General Candidate');
        }

        if (!sessionIdToValidate) {
          return;
        }

        const sessionCheck = await api.get(`/candidate/interview-session/${sessionIdToValidate}`);
        const verifiedSession = sessionCheck.data?.session;
        if (!verifiedSession?.id) {
          return;
        }

        if (verifiedSession.status === 'in_progress') {
          const persistedTranscriptTurns = Array.isArray(sessionCheck.data?.transcriptTurns)
            ? sessionCheck.data.transcriptTurns
            : [];
          const persistedTranscriptVersion = Number.isInteger(sessionCheck.data?.transcriptVersion)
            ? sessionCheck.data.transcriptVersion
            : 0;
          const inferredQuestionsAsked = persistedTranscriptTurns.filter((turn) => turn?.speaker === 'ai').length;

          setSessionData({
            session: verifiedSession,
            interviewRole: sessionCheck.data?.interviewRole || latestSession?.interview_role || plan?.role || 'General Candidate',
            interviewRoleSource: sessionCheck.data?.interviewRoleSource || latestSession?.role_source || 'default',
            interviewPlan: sessionCheck.data?.interviewPlan || plan,
            resumeSummary: sessionCheck.data?.resumeSummary || latestSession?.resume_summary || '',
          });
          const nextAiOutputMode = resolveAiOutputMode(sessionCheck.data?.aiOutputMode || DEFAULT_AI_OUTPUT_MODE);
          const resumedVoiceProvider = sessionCheck.data?.interviewPlan?.realtime?.voiceProvider || plan?.realtime?.voiceProvider;
          setAiOutputMode(resumedVoiceProvider === 'groq_browser' ? 'browser_tts' : nextAiOutputMode);
          setInterviewRole(sessionCheck.data?.interviewRole || latestSession?.interview_role || plan?.role || 'General Candidate');
          if (sessionCheck.data?.interviewPlan) {
            setInterviewPlan(sessionCheck.data.interviewPlan);
          }
          setResumeSummary(sessionCheck.data?.resumeSummary || latestSession?.resume_summary || '');
          setTranscriptTurns(persistedTranscriptTurns);
          lastAutosavedTranscriptRef.current = buildTranscriptFromTurns(persistedTranscriptTurns);
          lastRequestedTranscriptVersionRef.current = persistedTranscriptVersion;
          lastAppliedTranscriptVersionRef.current = persistedTranscriptVersion;
          setQuestionsAsked(inferredQuestionsAsked);
          questionsAskedRef.current = inferredQuestionsAsked;
          const latestTurn = persistedTranscriptTurns[persistedTranscriptTurns.length - 1];
          const awaitingReply = Boolean(latestTurn && latestTurn.speaker === 'ai');
          setAwaitingCandidateReply(awaitingReply);
          awaitingCandidateReplyRef.current = awaitingReply;
          // Keep consent gate state as-is to avoid bouncing back while live room initializes.
          startInterviewLock(verifiedSession.id);
        } else {
          // Recover from stale lock/session storage state.
          clearInterviewLock();
          setSessionData(null);
          setHasAcknowledgedNotice(false);
        }
      } catch (_error) {
        setSessionData(null);
        setHasAcknowledgedNotice(false);
        clearInterviewLock();
      }
    };

    fetchInterviewContext();
  }, [clearInterviewLock, routeSessionId, startInterviewLock]);

  useEffect(() => {
    // If lock exists but there is no current session, reset stale state.
    if (interviewLock?.active && !sessionData?.session?.id && !startingSession) {
      clearInterviewLock();
    }
  }, [clearInterviewLock, interviewLock?.active, sessionData?.session?.id, startingSession]);

  const startInterviewSession = async () => {
    try {
      setStartingSession(true);
      lastStartInterviewErrorRef.current = { message: '', at: 0 };
      setConnecting(true);
      const response = await api.post('/candidate/interview-session/start', {
        consentGiven: true,
      });

      setSessionData(response.data);
      const startedAiOutputMode = resolveAiOutputMode(response.data?.aiOutputMode || DEFAULT_AI_OUTPUT_MODE);
      const startedVoiceProvider = response.data?.interviewPlan?.realtime?.voiceProvider;
      setAiOutputMode(startedVoiceProvider === 'groq_browser' ? 'browser_tts' : startedAiOutputMode);
      setInterviewRole(response.data?.interviewRole || 'General Candidate');
      setInterviewPlan(response.data?.interviewPlan ?? null);
      setResumeSummary(response.data?.resumeSummary || '');
      setHasAcknowledgedNotice(true);
      if (response.data?.session?.id) {
        startInterviewLock(response.data.session.id);
      }
    } catch (error) {
      const message = error?.message || 'Unable to start interview session right now';
      const now = Date.now();
      const isDuplicateError =
        lastStartInterviewErrorRef.current.message === message && now - lastStartInterviewErrorRef.current.at < 5000;

      if (isDuplicateError) {
        return;
      }

      lastStartInterviewErrorRef.current = { message, at: now };

      if (
        message.includes('Scoring provider unavailable') ||
        message.includes('Scoring provider is not configured') ||
        message.includes('No configured LLM provider found') ||
        message.includes('408 Timeout')
      ) {
        if (startInterviewProviderErrorShownRef.current) {
          return;
        }

        startInterviewProviderErrorShownRef.current = true;
        toast.error('Interview services are still starting up. Please try again shortly.');
        return;
      }

      if (message.includes('already exists for this application stage')) {
        toast('Interview already exists for this stage. Redirecting to interview schedule.');
        setSessionData(null);
        setHasAcknowledgedNotice(false);
        clearInterviewLock();
        navigate('/interview', { replace: true });
        return;
      }
      toast.error(message);
    } finally {
      setStartingSession(false);
    }
  };

  const continueToInterview = async () => {
    if (sessionData?.session?.id) {
      setHasAcknowledgedNotice(true);
      return;
    }

    await startInterviewSession();
  };

  useEffect(() => {
    if (!isLiveInterviewRoute) {
      return;
    }

    if (!hasAcknowledgedNotice) {
      return;
    }

    if (!sessionData?.session?.id) {
      return;
    }

    let canceled = false;

    const startMedia = async () => {
      try {
        const existingStream = mediaStreamRef.current;
        if (existingStream && existingStream.getTracks().some((track) => track.readyState === 'live')) {
          if (videoRef.current) {
            videoRef.current.srcObject = existingStream;
          }
          setConnecting(false);
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });

        if (canceled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        mediaStreamRef.current = stream;

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }

        const recorder = new MediaRecorder(stream, {
          mimeType: 'video/webm;codecs=vp8,opus',
        });
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            recordedChunksRef.current.push(event.data);
          }
        };
        recorder.start(1000);
        mediaRecorderRef.current = recorder;

        autosaveQueuedRef.current = false;
        lastAutosavedTranscriptRef.current = '';
        lastRequestedTranscriptVersionRef.current = 0;
        lastAppliedTranscriptVersionRef.current = 0;
        questionsAskedRef.current = 0;
        awaitingCandidateReplyRef.current = false;
        autoCompletingRef.current = false;
        groqTurnInFlightRef.current = false;
        groqAutoKickoffDoneRef.current = false;
        speechFinalBufferRef.current = '';
        setSubmittingGroqTurn(false);
        setSpeakingAiResponse(false);
        setGroqDebugTimestamps({
          lastListenStart: null,
          lastSubmit: null,
          lastSpeakEnd: null,
        });
        stopVoiceAnswerCapture('manual', { skipSubmit: true });
        setQuestionsAsked(0);
        setAwaitingCandidateReply(false);
        setInterviewCompleteReason('');
        setResponses((prev) => (prev.length ? prev : questions.map(() => '')));
        setTranscriptTurns([]);
        setConnecting(false);
        toast.success('Live interview room is ready');
      } catch (_error) {
        if (canceled) {
          return;
        }
        toast.error('Camera and microphone permission is required for interview');
        setSessionData(null);
        setHasAcknowledgedNotice(false);
        clearInterviewLock();
        navigate('/interview', { replace: true });
      }
    };

    startMedia();

    return () => {
      canceled = true;
      cleanupRealtimeTransport();
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, [cleanupRealtimeTransport, clearInterviewLock, hasAcknowledgedNotice, isLiveInterviewRoute, navigate, sessionData?.session?.id, stopVoiceAnswerCapture]);

  useEffect(() => {
    if (!useGroqVoiceMode && capturingVoiceAnswer) {
      stopVoiceAnswerCapture('manual', { skipSubmit: true });
    }
  }, [capturingVoiceAnswer, stopVoiceAnswerCapture, useGroqVoiceMode]);

  useEffect(() => {
    if (connecting) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [connecting]);

  useEffect(() => {
    if (connecting || !hasAcknowledgedNotice || !sessionData?.session?.id || !mediaStreamRef.current) {
      return;
    }

    if (useGroqVoiceMode || aiOutputMode !== 'openai_stream') {
      cleanupRealtimeTransport();
      setRealtimeStatus('idle');
      return;
    }

    void startRealtimeTransport();
  }, [
    aiOutputMode,
    cleanupRealtimeTransport,
    connecting,
    hasAcknowledgedNotice,
    sessionData?.session?.id,
    startRealtimeTransport,
    useGroqVoiceMode,
  ]);

  useEffect(() => {
    if (!hasAcknowledgedNotice || connecting || !sessionData?.session?.id) {
      return;
    }

    if (useGroqVoiceMode) {
      if (!groqAutoKickoffDoneRef.current && questionsAskedRef.current === 0 && !loadingGroqQuestion) {
        groqAutoKickoffDoneRef.current = true;
        void requestGroqNextQuestion();
      }
      return;
    }

    if (!activeQuestion) {
      return;
    }

    const scriptedFallbackMode = aiOutputMode !== 'openai_stream' || realtimeStatus === 'fallback';
    if (!scriptedFallbackMode) {
      return;
    }

    // Phase 2: browser speech acts as resilient fallback while openai_stream transport is wired.
    speakText(activeQuestion);

    setTranscriptTurns((prev) => {
      const aiTurnId = `ai-${activeQuestionIndex}`;
      const existing = prev.find((turn) => turn.id === aiTurnId);
      if (existing) {
        return prev;
      }
      return [
        ...prev,
        {
          id: aiTurnId,
          speaker: 'ai',
          text: activeQuestion,
          timestamp: new Date().toISOString(),
        },
      ];
    });
  }, [
    activeQuestion,
    aiOutputMode,
    connecting,
    hasAcknowledgedNotice,
    loadingGroqQuestion,
    realtimeStatus,
    requestGroqNextQuestion,
    sessionData?.session?.id,
    speakText,
    useGroqVoiceMode,
  ]);

  const onAnswerChange = useCallback((value) => {
    const responseIndex = useGroqVoiceMode ? Math.max(questionsAsked - 1, 0) : activeQuestionIndex;

    setResponses((prev) => {
      const next = [...prev];
      next[responseIndex] = value;
      return next;
    });

    setTranscriptTurns((prev) => {
      const candidateTurnId = useGroqVoiceMode ? `candidate-groq-${questionsAsked}` : `candidate-${activeQuestionIndex}`;
      const idx = prev.findIndex((turn) => turn.id === candidateTurnId);
      const nextTurn = {
        id: candidateTurnId,
        speaker: 'candidate',
        text: value,
        timestamp: new Date().toISOString(),
      };

      if (idx === -1) {
        return [...prev, nextTurn];
      }

      const copy = [...prev];
      copy[idx] = nextTurn;
      return copy;
    });
  }, [activeQuestionIndex, questionsAsked, useGroqVoiceMode]);

  const startVoiceAnswerCapture = useCallback(() => {
    if (!useGroqVoiceMode) {
      return;
    }

    if (
      capturingVoiceAnswer ||
      loadingGroqQuestion ||
      groqTurnInFlightRef.current ||
      !awaitingCandidateReplyRef.current ||
      sessionFinalizedRef.current
    ) {
      return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (typeof SpeechRecognition !== 'function') {
      toast.error('Voice recognition is not supported in this browser.');
      return;
    }

    const responseIndex = Math.max(questionsAsked - 1, 0);
    const existingText = normalizeTranscriptText(responses[responseIndex] || '');
    speechFinalBufferRef.current = existingText;

    const recognition = new SpeechRecognition();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    const resetSilenceAutoStop = () => {
      clearSpeechSilenceTimer();
      speechSilenceTimerRef.current = window.setTimeout(() => {
        stopVoiceAnswerCapture('silence');
      }, VOICE_SILENCE_AUTO_STOP_MS);
    };

    recognition.onresult = (event) => {
      let interimText = '';
      let finalChunk = '';

      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const transcript = normalizeTranscriptText(event.results[index][0]?.transcript || '');
        if (!transcript) {
          continue;
        }
        if (event.results[index].isFinal) {
          finalChunk = `${finalChunk} ${transcript}`.trim();
        } else {
          interimText = `${interimText} ${transcript}`.trim();
        }
      }

      if (finalChunk) {
        speechFinalBufferRef.current = normalizeTranscriptText(`${speechFinalBufferRef.current} ${finalChunk}`);
      }

      const mergedText = normalizeTranscriptText(`${speechFinalBufferRef.current} ${interimText}`);
      if (mergedText) {
        onAnswerChange(mergedText);
        resetSilenceAutoStop();
      }
    };

    recognition.onerror = () => {
      clearSpeechSilenceTimer();
      setCapturingVoiceAnswer(false);
    };

    recognition.onend = () => {
      clearSpeechSilenceTimer();
      setCapturingVoiceAnswer(false);
      speechRecognitionRef.current = null;

      const skipSubmit = skipNextSpeechSubmitRef.current;
      skipNextSpeechSubmitRef.current = false;
      const finalizedText = normalizeTranscriptText(speechFinalBufferRef.current);
      speechFinalBufferRef.current = '';

      if (
        skipSubmit ||
        !useGroqVoiceMode ||
        !awaitingCandidateReplyRef.current ||
        !finalizedText ||
        sessionFinalizedRef.current ||
        groqTurnInFlightRef.current
      ) {
        return;
      }

      if (questionsAskedRef.current >= maxRealtimeQuestions) {
        setAwaitingCandidateReply(false);
        if (!autoCompletingRef.current) {
          autoCompletingRef.current = true;
          setInterviewCompleteReason('question_limit_reached');
        }
        return;
      }

      setAwaitingCandidateReply(false);
      void requestGroqNextQuestion({ candidateText: finalizedText });
    };

    try {
      speechRecognitionRef.current = recognition;
      recognition.start();
      setGroqDebugTimestamps((prev) => ({ ...prev, lastListenStart: new Date().toISOString() }));
      resetSilenceAutoStop();
      setCapturingVoiceAnswer(true);
    } catch (_error) {
      toast.error('Unable to start voice capture right now.');
      setCapturingVoiceAnswer(false);
    }
  }, [
    clearSpeechSilenceTimer,
    onAnswerChange,
    questionsAsked,
    responses,
    stopVoiceAnswerCapture,
    useGroqVoiceMode,
    capturingVoiceAnswer,
    loadingGroqQuestion,
    maxRealtimeQuestions,
    requestGroqNextQuestion,
  ]);

  useEffect(() => {
    startVoiceAnswerCaptureRef.current = startVoiceAnswerCapture;
  }, [startVoiceAnswerCapture]);

  useEffect(() => {
    if (!sessionData?.session?.id || !hasAcknowledgedNotice || sessionFinalizedRef.current) {
      return;
    }

    const attemptAutosave = async () => {
      if (autosaveInFlightRef.current) {
        autosaveQueuedRef.current = true;
        return;
      }

      const transcript = buildTranscriptFromTurns(transcriptTurnsRef.current);
      if (!transcript || transcript === lastAutosavedTranscriptRef.current) {
        return;
      }

      const nextTranscriptVersion = lastRequestedTranscriptVersionRef.current + 1;
      lastRequestedTranscriptVersionRef.current = nextTranscriptVersion;

      autosaveInFlightRef.current = true;
      setAutosavingTranscript(true);
      try {
        const response = await api.patch(`/candidate/interview-session/${sessionData.session.id}/transcript`, {
          transcript,
          transcriptTurns: transcriptTurnsRef.current,
          transcriptVersion: nextTranscriptVersion,
        });

        const serverVersion = response.data?.transcriptVersion;
        const applied = response.data?.applied !== false;

        if (Number.isInteger(serverVersion)) {
          lastAppliedTranscriptVersionRef.current = serverVersion;
          if (serverVersion > lastRequestedTranscriptVersionRef.current) {
            lastRequestedTranscriptVersionRef.current = serverVersion;
          }
        } else if (applied) {
          lastAppliedTranscriptVersionRef.current = nextTranscriptVersion;
        }

        if (applied) {
          lastAutosavedTranscriptRef.current = transcript;
        }
      } catch (_error) {
        // Keep recording even if autosave misses a tick.
      } finally {
        autosaveInFlightRef.current = false;
        setAutosavingTranscript(false);

        if (autosaveQueuedRef.current && !sessionFinalizedRef.current) {
          autosaveQueuedRef.current = false;
          window.setTimeout(() => {
            void attemptAutosave();
          }, 250);
        }
      }
    };

    const intervalId = window.setInterval(() => {
      void attemptAutosave();
    }, 5000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasAcknowledgedNotice, sessionData?.session?.id]);

  const onNextQuestion = () => {
    if (aiOutputMode === 'openai_stream' && realtimeConnectedRef.current) {
      const sent = sendRealtimeFollowupPrompt('followup');
      if (!sent) {
        toast.error('Realtime interviewer is reconnecting. Please try again.');
      }
      return;
    }

    if (activeQuestionIndex < questions.length - 1) {
      setActiveQuestionIndex((prev) => prev + 1);
    }
  };

  const submitTypedGroqAnswer = useCallback(() => {
    if (!useGroqVoiceMode || !sessionData?.session?.id) {
      return;
    }

    if (submittingGroqTurn || loadingGroqQuestion || groqTurnInFlightRef.current) {
      return;
    }

    if (!awaitingCandidateReplyRef.current) {
      toast('Wait for the AI interviewer question before submitting your response.');
      return;
    }

    const responseIndex = Math.max(questionsAskedRef.current - 1, 0);
    const typedAnswer = normalizeTranscriptText(responses[responseIndex] || '');
    if (!typedAnswer) {
      toast.error('Please type your response before submitting.');
      return;
    }

    if (capturingVoiceAnswer) {
      stopVoiceAnswerCapture('manual', { skipSubmit: true });
    }

    if (questionsAskedRef.current >= maxRealtimeQuestions) {
      setAwaitingCandidateReply(false);
      if (!autoCompletingRef.current) {
        autoCompletingRef.current = true;
        setInterviewCompleteReason('question_limit_reached');
      }
      return;
    }

    setAwaitingCandidateReply(false);
    void requestGroqNextQuestion({ candidateText: typedAnswer });
  }, [
    capturingVoiceAnswer,
    loadingGroqQuestion,
    maxRealtimeQuestions,
    requestGroqNextQuestion,
    responses,
    sessionData?.session?.id,
    stopVoiceAnswerCapture,
    submittingGroqTurn,
    useGroqVoiceMode,
  ]);

  const onEndInterview = useCallback(async (completionReason = 'manual_end') => {
    const safeCompletionReason = typeof completionReason === 'string' ? completionReason : 'manual_end';

    if (!sessionData?.session?.id) {
      toast.error('Interview session context is missing');
      return;
    }

    try {
      setCompleting(true);
      cleanupRealtimeTransport();
      if (capturingVoiceAnswer) {
        stopVoiceAnswerCapture('manual', { skipSubmit: true });
      }

      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }

      await new Promise((resolve) => window.setTimeout(resolve, 300));

      const recordingBlob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const sessionId = sessionData.session.id;
      const uploadResult = await uploadBlobToSignedUrl(recordingBlob, sessionId, 'video', 'webm');
      const storedVideoPath = uploadResult.path;
      const videoUploadNonce = uploadResult.uploadNonce;

      const fallbackTranscriptText = questions
        .map((question, index) => {
          const answer = responses[index] || '(no response captured)';
          return `Q${index + 1}: ${question}\nA${index + 1}: ${answer}`;
        })
        .join('\n\n');
      const transcriptText = transcriptSnapshot || fallbackTranscriptText;

      const completionResponse = await api.post(
        `/candidate/interview-session/${sessionId}/complete`,
        {
          transcript: transcriptText,
          durationSeconds: elapsedSeconds,
          videoPath: storedVideoPath,
          videoUploadNonce,
          videoUrl: null,
          scorePayload: {
            role: sessionData?.interviewRole,
            completionReason: safeCompletionReason,
            questionsAsked,
            maxQuestions: maxRealtimeQuestions,
            transcriptTurns,
          },
        },
        {
          timeout: 90000,
        },
      );

      sessionFinalizedRef.current = true;
      clearInterviewLock();
      await exitFullscreenSafely();
      const scoringStatus = completionResponse?.data?.scoringStatus;
      if (scoringStatus === 'pending') {
        toast.success('Interview submitted. Scoring is queued and will be available shortly.');
      } else {
        toast.success(
          safeCompletionReason === 'question_limit_reached'
            ? 'Interview completed after the planned number of questions'
            : 'Interview completed and submitted',
        );
      }
      navigate('/candidate', { replace: true });
    } catch (error) {
      const message = error?.message || 'Unable to complete interview session';
      const normalized = message.toLowerCase();
      const isAlreadyFinalizedError =
        normalized.includes('not in progress') ||
        normalized.includes('already finalized') ||
        normalized.includes('already completed') ||
        normalized.includes('409');

      if (isAlreadyFinalizedError) {
        sessionFinalizedRef.current = true;
        clearInterviewLock();
        await exitFullscreenSafely();
        toast.success('Interview is already finalized. Redirecting to dashboard.');
        navigate('/candidate', { replace: true });
        return;
      }

      if (normalized.includes('408 timeout')) {
        try {
          const statusResponse = await api.get(`/candidate/interview-session/${sessionData.session.id}`, {
            timeout: 20000,
          });
          const currentStatus = statusResponse?.data?.session?.status;
          if (currentStatus === 'completed') {
            sessionFinalizedRef.current = true;
            clearInterviewLock();
            await exitFullscreenSafely();
            toast.success('Interview completion is still processing. Redirecting to dashboard.');
            navigate('/candidate', { replace: true });
            return;
          }
        } catch (_statusError) {
          // Fall through to default timeout message.
        }
      }

      toast.error(message || 'Unable to complete interview session');
    } finally {
      setCompleting(false);
    }
  }, [
    cleanupRealtimeTransport,
    clearInterviewLock,
    elapsedSeconds,
    exitFullscreenSafely,
    maxRealtimeQuestions,
    navigate,
    questions,
    questionsAsked,
    responses,
    sessionData?.interviewRole,
    sessionData?.session?.id,
    capturingVoiceAnswer,
    stopVoiceAnswerCapture,
    transcriptSnapshot,
    transcriptTurns,
  ]);

  useEffect(() => {
    if (!interviewCompleteReason || sessionFinalizedRef.current || completing || terminating) {
      return;
    }

    if (interviewCompleteReason === 'question_limit_reached') {
      void onEndInterview('question_limit_reached');
    }
  }, [completing, interviewCompleteReason, onEndInterview, terminating]);

  if (!sessionData?.session?.id) {
    if (startingSession) {
      return (
        <Card>
          <h2 className="text-xl font-black text-slate-900">Starting Interview Session</h2>
          <p className="mt-2 text-sm text-slate-600">Preparing your secure interview room...</p>
        </Card>
      );
    }

    return (
      <Card>
        <h2 className="text-xl font-black text-slate-900">Before You Start</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          This interview records your audio, video, and transcript for hiring evaluation.
          These interview artifacts are retained only for recruitment decisions and are deleted
          once your final hiring outcome is completed (hired or not hired).
        </p>
        <p className="mt-2 text-xs text-slate-500">
          By continuing, you consent to recording and processing for evaluation purposes.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={continueToInterview} disabled={startingSession}>
            {startingSession ? 'Starting...' : 'I Understand, Continue'}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/interview')}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  if (!hasAcknowledgedNotice) {
    return (
      <Card>
        <h2 className="text-xl font-black text-slate-900">Before You Start</h2>
        <p className="mt-2 text-sm leading-6 text-slate-700">
          This interview records your audio, video, and transcript for hiring evaluation.
          These interview artifacts are retained only for recruitment decisions and are deleted
          once your final hiring outcome is completed (hired or not hired).
        </p>
        <p className="mt-2 text-xs text-slate-500">
          By continuing, you consent to recording and processing for evaluation purposes.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button onClick={continueToInterview} disabled={startingSession}>
            {startingSession ? 'Starting...' : 'I Understand, Continue'}
          </Button>
          <Button variant="secondary" onClick={() => navigate('/interview')}>
            Cancel
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
        <h1 className="text-2xl font-black text-slate-900">Live AI Interview</h1>
        <p className="mt-1 text-sm text-slate-600">
          Role: <span className="font-semibold text-slate-800">{sessionData?.interviewRole}</span>
        </p>
      </motion.div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3 inline-flex items-center gap-2 text-slate-900">
            <Camera size={18} className="text-teal-700" />
            <h2 className="text-lg font-bold">Candidate Camera + Mic</h2>
          </div>
          <div className="overflow-hidden rounded-xl border border-slate-200 bg-black">
            <video ref={videoRef} autoPlay muted playsInline className="h-[260px] w-full object-cover" />
          </div>
          <div className="mt-3 flex items-center gap-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
            <span className="inline-flex items-center gap-1">
              <Video size={14} /> Video On
            </span>
            <span className="inline-flex items-center gap-1">
              <Mic size={14} /> Audio On
            </span>
            <span>{Math.floor(elapsedSeconds / 60)}m {elapsedSeconds % 60}s</span>
          </div>
        </Card>

        <Card>
          <div className="mb-3 inline-flex items-center gap-2 text-slate-900">
            <PhoneCall size={18} className="text-indigo-700" />
            <h2 className="text-lg font-bold">AI Interviewer</h2>
          </div>
          <p className="text-xs text-slate-500">
            AI output mode: {aiOutputMode === 'openai_stream' ? 'openai_stream (browser voice fallback active)' : 'browser_tts'}
          </p>
          {useGroqVoiceMode ? (
            <p className="mt-1 text-xs text-emerald-700">Coding interviewer enabled with browser voice playback.</p>
          ) : null}
          {aiOutputMode === 'openai_stream' ? (
            <p className="mt-1 text-xs text-indigo-700">
              Realtime transport: {realtimeStatus === 'connected' ? 'connected' : realtimeStatus === 'connecting' ? 'connecting...' : 'fallback'}
            </p>
          ) : null}
          <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
          <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-sm text-indigo-900">
            <p className="text-xs font-semibold uppercase tracking-wide">Resume context</p>
            <p className="mt-1 line-clamp-5">{resumeSummary || 'Resume summary unavailable for this session.'}</p>
          </div>

          {(aiOutputMode !== 'openai_stream' || realtimeStatus === 'fallback') && activeQuestion && (
            <div className="mt-4 rounded-xl border-2 border-teal-500 bg-gradient-to-br from-teal-50 to-cyan-50 p-4 shadow-md">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-bold uppercase tracking-widest text-teal-700">
                  ✨ Question {useGroqVoiceMode ? questionsAsked || 1 : activeQuestionIndex + 1} of {useGroqVoiceMode ? maxRealtimeQuestions : questions.length}
                </p>
                <span className="inline-block bg-teal-600 text-white text-xs font-bold px-2 py-1 rounded">Your Turn</span>
              </div>
              <div className="bg-white rounded-lg p-3 mb-3 border border-teal-200">
                <p className="text-sm font-semibold text-slate-900 leading-relaxed">
                  {useGroqVoiceMode ? (transcriptTurns.filter((turn) => turn.speaker === 'ai').slice(-1)[0]?.text || 'Loading interview question...') : activeQuestion}
                </p>
              </div>
              <div className="space-y-2">
                <p className="text-xs text-teal-700 font-semibold">Share Your Response:</p>
                <textarea
                  className="w-full rounded-lg border-2 border-teal-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-200 placeholder-slate-400"
                  value={responses[useGroqVoiceMode ? Math.max(questionsAsked - 1, 0) : activeQuestionIndex] || ''}
                  onChange={(event) => onAnswerChange(event.target.value)}
                  placeholder="Type your detailed response here or use voice capture..."
                  rows={3}
                />
              </div>
              {useGroqVoiceMode ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant={capturingVoiceAnswer ? 'primary' : 'secondary'}
                    onClick={capturingVoiceAnswer ? stopVoiceAnswerCapture : startVoiceAnswerCapture}
                    disabled={!speechRecognitionSupported}
                    className={`gap-1.5 ${capturingVoiceAnswer ? 'bg-red-600 hover:bg-red-700' : ''}`}
                  >
                    <Mic size={16} />
                    {capturingVoiceAnswer ? '🔴 Stop Recording' : '🎤 Start Voice Capture'}
                  </Button>
                  {!speechRecognitionSupported ? (
                    <>
                      <p className="text-xs text-amber-700">Speech recognition not available in this browser. Use typed submit.</p>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={submitTypedGroqAnswer}
                        disabled={submittingGroqTurn || loadingGroqQuestion || !awaitingCandidateReply}
                      >
                        {submittingGroqTurn || loadingGroqQuestion ? 'Submitting...' : 'Submit Typed Response'}
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs text-slate-500">Voice capture auto-stops after about 2.5s of silence.</p>
                  )}
                </div>
              ) : null}
            </div>
          )}

          {(aiOutputMode === 'openai_stream' && realtimeStatus !== 'fallback') || useGroqVoiceMode ? (
            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {useGroqVoiceMode ? 'Coding interview progress' : 'Realtime interview progress'}
              </p>
              <p className="mt-2 text-sm text-slate-900">
                Questions asked: <span className="font-semibold">{questionsAsked}</span> / {maxRealtimeQuestions}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                {awaitingCandidateReply
                  ? 'AI is waiting for your response.'
                  : useGroqVoiceMode
                    ? 'The next coding question is fetched automatically after your voice response.'
                    : 'AI will ask the next question automatically.'}
              </p>
              {useGroqVoiceMode ? (
                <div className="mt-3 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-teal-700">
                    Auto-flow status: {groqAutoFlowStatus}
                  </p>
                  <p className="mt-1 text-xs text-teal-800">{groqAutoFlowStatusText}</p>
                  <p className="mt-1 text-[11px] text-teal-700/90">
                    listen {formatDebugTime(groqDebugTimestamps.lastListenStart)} | submit {formatDebugTime(groqDebugTimestamps.lastSubmit)} | speak-end {formatDebugTime(groqDebugTimestamps.lastSpeakEnd)}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">💬 Conversation</p>
              {autosavingTranscript ? <p className="text-xs text-teal-600">Saving...</p> : null}
            </div>
            <div className="max-h-48 overflow-y-auto rounded-lg bg-gradient-to-b from-slate-50 to-slate-100 p-4 space-y-3">
              {transcriptTurns.length ? (
                <>
                  {transcriptTurns.map((turn, index) => {
                    const isAI = turn.speaker === 'ai';
                    return (
                      <motion.div
                        key={turn.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className={`flex ${isAI ? 'justify-start' : 'justify-end'}`}
                      >
                        <div
                          className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                            isAI
                              ? 'bg-white text-slate-800 border border-slate-200 shadow-sm'
                              : 'bg-teal-600 text-white shadow-md'
                          }`}
                        >
                          <p className="text-xs font-semibold mb-1 opacity-75">
                            {isAI ? '🤖 AI Interviewer' : '👤 You'}
                          </p>
                          <p className="leading-relaxed">{turn.text || '(typing...)'}</p>
                        </div>
                      </motion.div>
                    );
                  })}
                  {loadingGroqQuestion && (
                    <motion.div
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex justify-start"
                    >
                      <div className="bg-white text-slate-600 rounded-lg px-3 py-2 text-sm border border-slate-200 shadow-sm">
                        <p className="text-xs font-semibold mb-1 opacity-75">🤖 AI Interviewer</p>
                        <div className="flex gap-1.5">
                          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce"></span>
                          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></span>
                          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></span>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </>
              ) : (
                <p className="text-sm text-slate-500 text-center py-6">
                  No conversation yet. Start the interview to begin.
                </p>
              )}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {!useGroqVoiceMode ? (
              <Button
                variant="secondary"
                onClick={onNextQuestion}
                disabled={
                  aiOutputMode === 'openai_stream'
                    ? realtimeStatus === 'connecting' || questionsAsked >= maxRealtimeQuestions
                    : activeQuestionIndex >= questions.length - 1
                }
              >
                {aiOutputMode === 'openai_stream' ? 'Force Next Follow-up' : 'Next Question'}
              </Button>
            ) : null}
            <Button onClick={onEndInterview} disabled={connecting || completing || terminating} className="gap-1.5">
              <PhoneOff size={16} /> {completing ? 'Submitting...' : 'End Interview'}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
