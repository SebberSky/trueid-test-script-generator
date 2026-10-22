export function mediaKind(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (/^image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)$/.test(mime)) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}
function link(label, href) {
  const anchor = document.createElement('a'); anchor.className = 'btn'; anchor.textContent = label;
  anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; return anchor;
}
export function renderMedia(ticket, container) {
  container.replaceChildren();
  const media = ticket?.media || {attachments: ticket?.attachments || [], external: [], unresolved: []};
  const total = media.attachments.length + media.external.length + media.unresolved.length;
  container.hidden = !total;
  if (!total) return;
  const heading = document.createElement('h3'); heading.textContent = `Media & files (${total})`; container.append(heading);
  const note = document.createElement('p'); note.className = 'hint'; note.textContent = 'รูป / วิดีโอ / เสียงเปิด preview ได้ตาม format ที่ browser รองรับ ไฟล์ทุกชนิดดาวน์โหลดได้ ส่วน media ภายนอกเปิดจากลิงก์ต้นฉบับ ข้อมูลในภาพหรือคลิปยังไม่ได้ถูก AI อ่านหรือถอดเสียง'; container.append(note);
  for (const file of media.attachments) {
    const card = document.createElement('article'); card.className = 'media-card';
    const name = document.createElement('strong'); name.textContent = file.filename; card.append(name);
    const info = document.createElement('p'); info.className = 'hint'; info.textContent = `${file.mimeType} · ${Number(file.size).toLocaleString()} bytes · ${(file.sources || ['Attachments']).join(', ')}`; card.append(info);
    const kind = mediaKind(file.mimeType);
    const status = document.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status');
    let preview;
    if (kind === 'image') { preview = document.createElement('img'); preview.alt = file.filename; preview.loading = 'lazy'; }
    if (kind === 'video' || kind === 'audio') { preview = document.createElement(kind); preview.controls = true; preview.preload = 'none'; }
    if (preview && file.previewUrl) {
      preview.className = 'media-preview'; preview.src = file.previewUrl;
      preview.addEventListener('error', () => { status.textContent = 'เปิด preview ไม่ได้: session / สิทธิ์ Jira / codec อาจไม่รองรับ กรุณาลองดาวน์โหลดหรือเปิดใน Jira'; });
      card.append(preview);
    }
    if (kind === 'pdf') status.textContent = 'PDF: กดเปิดไฟล์เพื่อดูใน PDF viewer ของ browser หรือดาวน์โหลด';
    else if (kind === 'file') status.textContent = 'ไฟล์ชนิดนี้ไม่มี preview ในหน้านี้ ดาวน์โหลดแล้วเปิดด้วยโปรแกรมที่รองรับ';
    const actions = document.createElement('div'); actions.className = 'row';
    if (file.previewUrl) actions.append(link('Open file', file.previewUrl));
    if (file.downloadUrl) actions.append(link('Download', file.downloadUrl));
    if (ticket?.url) actions.append(link('Open in Jira', ticket.url));
    card.append(status, actions); container.append(card);
  }
  for (const item of [...media.external, ...media.unresolved]) {
    const card = document.createElement('article'); card.className = 'media-card';
    const title = document.createElement('strong'); title.textContent = item.filename || item.url || 'Embedded media';
    const source = document.createElement('p'); source.className = 'hint'; source.textContent = (item.sources || []).join(', ');
    const warning = document.createElement('p'); warning.className = 'hint'; warning.textContent = item.warning || 'External media / link — เปิดจากผู้ให้บริการต้นฉบับ อาจต้อง Login เพิ่ม';
    card.append(title, source, warning);
    if (item.url || item.jiraUrl) card.append(link(item.url ? 'Open original link' : 'Open in Jira', item.url || item.jiraUrl));
    container.append(card);
  }
}
