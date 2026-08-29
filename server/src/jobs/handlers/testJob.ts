// Author: Preston Lee

import type { JobHandler } from '../types.js';

export const testJobHandler: JobHandler = async (ctx) => {
  const input = (ctx.job.input as Record<string, any>) || {};
  const steps = typeof input.steps === 'number' && input.steps > 0 ? Math.min(input.steps, 20) : 5;
  const stepDelayMs = typeof input.stepDelayMs === 'number' && input.stepDelayMs > 0 ? Math.min(input.stepDelayMs, 5000) : 1000;
  const failAtStep = typeof input.failAtStep === 'number' ? input.failAtStep : null;

  await ctx.updateProgress(0, 'Initializing generic worker test execution');

  for (let i = 1; i <= steps; i++) {
    if (ctx.signal.aborted || (await ctx.isCancelled())) {
      throw new Error('Job was cancelled by administrator or client.');
    }

    if (failAtStep === i) {
      throw new Error(`Simulated test job failure at step ${i} of ${steps}`);
    }

    await new Promise((resolve) => setTimeout(resolve, stepDelayMs));

    const percent = Math.round((i / steps) * 100);
    const stageDesc = `Executing step ${i} of ${steps}: ${input.message || 'Processing payload batch'}`;
    await ctx.updateProgress(percent, stageDesc);
  }

  return {
    message: 'Generic worker test job executed successfully.',
    totalSteps: steps,
    completedAt: new Date().toISOString(),
    inputEcho: input,
  };
};
