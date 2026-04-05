import { expect, test } from '@playwright/test';

/**
 * Lightweight skeleton for interview auto-flow regression checks.
 *
 * To enable fully:
 * 1) Install Playwright in frontend: npm i -D @playwright/test
 * 2) Install browser binaries: npx playwright install
 * 3) Implement auth bootstrap helper so /interview/live is reachable as a candidate
 *    without interactive Supabase login.
 */

test.describe('Interview auto-flow (non-voice, mocked)', () => {
  test.skip(true, 'Skeleton test: enable after auth bootstrap helper is added.');

  test.beforeEach(async ({ page }) => {
    // Keep this suite non-voice and deterministic.
    await page.addInitScript(() => {
      window.SpeechRecognition = undefined;
      window.webkitSpeechRecognition = undefined;
    });

    // Mock core interview APIs used by the automated Groq flow.
    await page.route('**/candidate/interview-slots', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          interviewPlan: {
            role: 'Backend Developer',
            flow: ['intro', 'problem-solving'],
            realtime: { voiceProvider: 'groq_browser', maxQuestions: 2 },
            questions: ['Q1 placeholder', 'Q2 placeholder'],
          },
          latestSession: null,
        }),
      });
    });

    await page.route('**/candidate/interview-session/start', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session: { id: '00000000-0000-0000-0000-000000000123', status: 'in_progress' },
          interviewRole: 'Backend Developer',
          interviewPlan: {
            realtime: { voiceProvider: 'groq_browser', maxQuestions: 2 },
            questions: ['Q1 placeholder', 'Q2 placeholder'],
          },
          resumeSummary: 'Mocked resume summary',
        }),
      });
    });

    let questionCounter = 0;
    await page.route('**/candidate/interview-session/**/next-question', async (route) => {
      questionCounter += 1;
      const payload =
        questionCounter === 1
          ? {
              completed: false,
              question: 'Q1/2: Tell me about your backend API design process.',
              questionNumber: 1,
              maxQuestions: 2,
              transcriptVersion: 1,
            }
          : {
              completed: false,
              question: 'Q2/2: How do you handle retries and idempotency?',
              questionNumber: 2,
              maxQuestions: 2,
              transcriptVersion: 2,
            };

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    });

    await page.route('**/candidate/interview-session/**/transcript', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: 'Transcript autosaved',
          applied: true,
          transcriptVersion: 2,
        }),
      });
    });

    // TODO: Add a deterministic candidate auth bootstrap helper.
    // Until this is implemented, keep the suite skipped.
  });

  test('shows debug auto-flow status and supports typed submit fallback', async ({ page }) => {
    await page.goto('/interview/live');

    await page.getByRole('button', { name: /I Understand, Continue/i }).click();

    await expect(page.getByText(/Auto-flow status:/i)).toBeVisible();
    await expect(page.getByText(/listen .* submit .* speak-end/i)).toBeVisible();

    await page.getByPlaceholder('Type your detailed response here or use voice capture...').fill(
      'I design API contracts first and validate retry behavior with idempotency keys.',
    );
    await page.getByRole('button', { name: /Submit Typed Response/i }).click();

    await expect(page.getByText(/How do you handle retries and idempotency/i)).toBeVisible();
  });
});
