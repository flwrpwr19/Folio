export async function trackJob(invoke, job, onUpdate) {
  if (!job?.job_id) return null;
  let status = null;
  for (;;) {
    status = await invoke('get_job_status', { jobId: job.job_id });
    onUpdate?.(status);
    if (['completed', 'cancelled', 'failed'].includes(status.state)) return status;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}
