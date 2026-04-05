import React from 'react';
import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { FileCheck2, Upload } from 'lucide-react';
import toast from 'react-hot-toast';
import api from '../../lib/axios';
import Button from '../../components/ui/Button';
import Card from '../../components/ui/Card';
import Input from '../../components/ui/Input';
import { buildResumePath, MAX_RESUME_SIZE_BYTES, RESUME_BUCKET, sanitizeResumeFileName } from '../../lib/resumeStorage';
import { supabase } from '../../lib/supabase';

export default function ProfileUpload() {
  const [file, setFile] = useState(null);
  const [targetRole, setTargetRole] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [lastUpload, setLastUpload] = useState(null);
  const [pendingResumeUpload, setPendingResumeUpload] = useState(null);
  const inputRef = useRef(null);

  const uploadToSupabaseStorage = async (fileToUpload, uploadPath) => {
    return new Promise((resolve, reject) => {
      const uploadResultPromise = api.post('/candidate/storage/signed-upload', {
        path: uploadPath,
      });

      uploadResultPromise
        .then((response) => {
          if (!response.data?.signedUrl) {
            reject(new Error('Unable to create signed upload URL'));
            return;
          }

          const xhr = new XMLHttpRequest();

          xhr.open('PUT', response.data.signedUrl, true);
          xhr.setRequestHeader('Content-Type', fileToUpload.type || 'application/pdf');
          xhr.setRequestHeader('x-upsert', 'false');

          xhr.upload.addEventListener('progress', (event) => {
            if (event.lengthComputable) {
              setUploadProgress(Math.round((event.loaded / event.total) * 100));
            }
          });

          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve();
              return;
            }

            reject(new Error('Unable to upload resume to Supabase Storage'));
          };

          xhr.onerror = () => {
            reject(new Error('Network error while uploading resume'));
          };

          xhr.send(fileToUpload);
        })
        .catch(reject);
    });
  };

  const cancelResumeUpload = async () => {
    if (pendingResumeUpload?.path) {
      try {
        await supabase.storage.from(RESUME_BUCKET).remove([pendingResumeUpload.path]);
        toast.success('Resume upload cancelled and file removed');
      } catch (error) {
        toast.error('Unable to remove uploaded resume');
      }
    }
    setPendingResumeUpload(null);
  };

  const confirmResumeUpload = async () => {
    if (!pendingResumeUpload) return;

    try {
      setSubmitting(true);
      const response = await api.post('/candidate/profile-upload', {
        filename: pendingResumeUpload.fileName,
        size: pendingResumeUpload.fileSize,
        type: pendingResumeUpload.type,
        filePath: pendingResumeUpload.path,
        fileUrl: pendingResumeUpload.publicUrl,
        targetRole: targetRole.trim(),
        submittedAt: new Date().toISOString(),
      });

      setLastUpload(response.data?.upload ?? pendingResumeUpload);
      toast.success('Resume uploaded and queued for AI parsing');
      setPendingResumeUpload(null);
      setFile(null);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    } catch (error) {
      const errorMsg = error.message || 'Unable to save resume metadata';
      if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
        toast.error('Your session has expired. Please sign in again.', { duration: 5000 });
      } else if (errorMsg.includes('CORS') || errorMsg.includes('ERR_FAILED') || errorMsg.includes('connect')) {
        toast.error('Server is not reachable. Please ensure the backend is running.', { duration: 5000 });
      } else {
        toast.error(errorMsg, { duration: 4000 });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const onFileChange = (event) => {
    const selectedFile = event.target.files?.[0];

    if (!selectedFile) {
      setFile(null);
      return;
    }

    const isPdf = selectedFile.type === 'application/pdf';
    if (!isPdf) {
      toast.error('Only PDF files are allowed');
      event.target.value = '';
      return;
    }

    if (selectedFile.size > MAX_RESUME_SIZE_BYTES) {
      toast.error('Resume size should stay under 10MB');
      event.target.value = '';
      return;
    }

    setFile(selectedFile);
  };

  const onSubmit = async (event) => {
    event.preventDefault();

    if (!file) {
      toast.error('Please choose a resume PDF');
      return;
    }

    if (!targetRole.trim()) {
      toast.error('Please enter a target interview role');
      return;
    }

    let uploadedPath = null;
    setUploadProgress(0);

    try {
      setSubmitting(true);
      const {
        data: { session },
        error: userError,
      } = await supabase.auth.getSession();

      if (userError) {
        throw new Error('Unable to verify login status. Please try again.');
      }

      const user = session?.user;

      if (!user) {
        toast.error('Please sign in to your account to upload files', { duration: 5000 });
        throw new Error('Not authenticated');
      }

      if (!session?.access_token) {
        toast.error('Your session has expired. Please sign in again.', { duration: 5000 });
        throw new Error('No access token');
      }

      uploadedPath = buildResumePath(user.id, file.name);

      await uploadToSupabaseStorage(file, uploadedPath);
      setUploadProgress(50);

      const {
        data: { publicUrl },
      } = supabase.storage.from(RESUME_BUCKET).getPublicUrl(uploadedPath);

      // Show confirmation dialog before committing to backend
      setPendingResumeUpload({
        path: uploadedPath,
        fileName: file.name,
        fileSize: file.size,
        type: file.type,
        publicUrl,
      });
      setUploadProgress(100);

    } catch (error) {
      if (uploadedPath) {
        await supabase.storage.from(RESUME_BUCKET).remove([uploadedPath]);
      }

      setUploadProgress(0);
      const errorMsg = error.message || 'Unable to upload resume';
      if (errorMsg.includes('Not authenticated') || errorMsg.includes('No access token')) {
        // Auth error already shown in UI above
        return;
      }
      if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
        toast.error('Your session has expired. Please sign in again.', { duration: 5000 });
      } else if (errorMsg.includes('CORS') || errorMsg.includes('ERR_FAILED') || errorMsg.includes('connect')) {
        toast.error('Server is not reachable. Please ensure the backend is running.', { duration: 5000 });
      } else {
        toast.error(errorMsg, { duration: 4000 });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-auto w-full max-w-2xl">
      <Card>
        <h1 className="text-2xl font-black text-slate-900">Profile Upload</h1>
        <p className="mt-2 text-sm text-slate-600">Upload your latest PDF resume for AI-based screening.</p>

        <form onSubmit={onSubmit} className="mt-6 space-y-6">
          <div>
            <label htmlFor="targetRole" className="mb-1.5 block text-sm font-medium text-slate-700">
              Target interview role
            </label>
            <Input
              id="targetRole"
              name="targetRole"
              type="text"
              value={targetRole}
              onChange={(event) => setTargetRole(event.target.value)}
              placeholder="e.g., Frontend Developer"
              required
            />
          </div>

          {/* Resume Upload Section */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Resume (Required)</h3>
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-teal-300 bg-teal-50/60 p-8 text-center transition hover:bg-teal-50">
              <Upload className="text-teal-700" size={28} />
              <span className="mt-2 text-sm font-semibold text-slate-900">Click to upload PDF</span>
              <span className="mt-1 text-xs text-slate-500">Max 10MB recommended</span>
              <input ref={inputRef} type="file" accept="application/pdf" className="hidden" onChange={onFileChange} />
            </label>

            {file && (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-emerald-100 px-3 py-2 text-sm font-medium text-emerald-700">
                <FileCheck2 size={16} /> {file.name}
              </div>
            )}
          </div>

          {submitting && (
            <div className="space-y-2 rounded-xl border border-teal-100 bg-teal-50 p-4">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-teal-800">
                <span>Uploading to Supabase Storage</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-teal-100">
                <div
                  className="h-full rounded-full bg-teal-600 transition-all duration-200"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {pendingResumeUpload && !submitting && (
            <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-semibold text-amber-900">Review Resume Upload</p>
              <div className="space-y-1 text-sm">
                <p className="text-amber-900">
                  File: <span className="font-medium">{pendingResumeUpload.fileName}</span>
                </p>
                <p className="text-xs text-amber-700">
                  Size: {(pendingResumeUpload.fileSize / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
              <p className="text-xs text-amber-700">
                Your resume has been uploaded to storage. Review and confirm to save metadata or cancel to delete.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={cancelResumeUpload}
                  disabled={submitting}
                  className="flex-1 rounded-lg border border-amber-300 bg-white px-4 py-2 text-sm font-semibold text-amber-700 transition hover:bg-amber-50 disabled:opacity-50"
                >
                  Cancel Upload
                </button>
                <button
                  type="button"
                  onClick={confirmResumeUpload}
                  disabled={submitting}
                  className="flex-1 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-amber-700 disabled:opacity-50"
                >
                  Confirm & Save
                </button>
              </div>
            </div>
          )}

          {lastUpload && !submitting && (
            <div className="space-y-2 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-semibold">Resume uploaded</p>
              <p>
                Stored file: <span className="font-medium">{lastUpload.file_name}</span>
              </p>
              <p className="break-all text-xs text-emerald-800">Path: {lastUpload.file_path}</p>
              {lastUpload.file_url && (
                <a
                  href={lastUpload.file_url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex text-xs font-semibold text-emerald-700 underline-offset-4 hover:underline"
                >
                  Open uploaded file
                </a>
              )}
            </div>
          )}

          <p className="text-xs text-slate-500">
            Your resume is uploaded directly to Supabase Storage first, then the backend stores the file metadata and parses the content for AI analysis.
          </p>

          {!pendingResumeUpload && (
            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? 'Uploading...' : 'Upload Resume'}
            </Button>
          )}
        </form>
      </Card>
    </motion.div>
  );
}
