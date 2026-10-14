const form = document.querySelector('#download-form');
const message = document.querySelector('#message');
const tasks = document.querySelector('#tasks');
const labels = { downloading: '下载中', complete: '已完成', failed: '失败', cancelled: '已取消' };
const bytes = n => n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}
async function refresh() {
  try {
    const jobs = await request('/api/jobs');
    tasks.replaceChildren();
    if (!jobs.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '还没有下载任务，粘贴链接即可开始。'; tasks.append(p); }
    for (const job of jobs.reverse()) {
      const card = document.createElement('article');
      const title = document.createElement('h3'); title.textContent = job.name;
      const link = document.createElement('p'); link.className = 'source'; link.textContent = job.url;
      const progress = document.createElement('progress'); progress.max = job.total || Math.max(job.received, 1); progress.value = job.received;
      progress.setAttribute('aria-label', `${job.name} 下载进度`);
      const detail = document.createElement('p'); detail.textContent = `${labels[job.status]} · ${bytes(job.received)}${job.total ? ` / ${bytes(job.total)}` : ''}${job.error ? ` · ${job.error}` : ''}`;
      const actions = document.createElement('div'); actions.className = 'actions';
      if (job.status === 'complete') { const save = document.createElement('a'); save.href = `/api/jobs/${job.id}/file`; save.textContent = '保存文件'; save.className = 'save'; actions.append(save); }
      const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = job.status === 'downloading' ? '取消' : '清理';
      remove.onclick = async () => { try { await request(`/api/jobs/${job.id}`, { method: 'DELETE' }); await refresh(); } catch (error) { message.textContent = error.message; } };
      actions.append(remove); card.append(title, link, progress, detail, actions); tasks.append(card);
    }
  } catch (error) { message.textContent = `连接失败：${error.message}`; }
}
form.onsubmit = async event => {
  event.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
  try { await request('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: document.querySelector('#url').value }) }); message.textContent = '下载任务已添加'; form.reset(); await refresh(); }
  catch (error) { message.textContent = error.message; }
  finally { button.disabled = false; }
};
void refresh();
setInterval(refresh, 1000);
