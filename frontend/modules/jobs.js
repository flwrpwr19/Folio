import { listen } from '@tauri-apps/api/event';

export async function trackJob(invoke, job, onUpdate) {
  if (!job?.job_id) return null;

  let status = await invoke('get_job_status', { jobId: job.job_id });
  onUpdate?.(status);
  if (['completed', 'cancelled', 'failed'].includes(status.state)) return status;

  let unlisten = null;
  try {
    unlisten = await listen('job-update', (event) => {
      const payload = event.payload;
      if (payload?.job_id === job.job_id) {
        status = payload;
        onUpdate?.(payload);
      }
    });
  } catch {
    /* event API unavailable */
  }

  try {
    for (;;) {
      if (['completed', 'cancelled', 'failed'].includes(status.state)) return status;
      await new Promise((resolve) => setTimeout(resolve, 400));
      status = await invoke('get_job_status', { jobId: job.job_id });
      onUpdate?.(status);
    }
  } finally {
    if (typeof unlisten === 'function') unlisten();
  }
}
