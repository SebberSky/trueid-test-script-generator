export function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}
export function collectMedia(node, source, result = []) {
  if (!node) return result;
  if (typeof node === 'string') {
    for (const match of node.matchAll(/!([^!\n]+)!/g)) result.push({kind: 'file', filename: match[1].split('|')[0].trim(), source});
    return result;
  }
  if (Array.isArray(node)) { for (const child of node) collectMedia(child, source, result); return result; }
  const attrs = node.attrs || {};
  if (['media', 'mediaInline'].includes(node.type)) {
    const url = safeExternalUrl(attrs.url);
    result.push({kind: url ? 'external' : 'file', mediaId: attrs.id ? String(attrs.id) : null, filename: attrs.alt || attrs.__fileName || '', url, source});
  }
  if (['inlineCard', 'blockCard', 'embedCard'].includes(node.type)) {
    const url = safeExternalUrl(attrs.url);
    if (url) result.push({kind: 'external', url, filename: attrs.title || '', source});
  }
  for (const mark of node.marks || []) {
    const url = mark.type === 'link' && safeExternalUrl(mark.attrs?.href);
    if (url) result.push({kind: 'external', url, filename: node.text || '', source});
  }
  for (const child of node.content || []) collectMedia(child, source, result);
  return result;
}
export function mediaDownloadPath(key, cloudId, attachmentId, download = false) {
  return '/api/jira/attachment?' + new URLSearchParams({ticket: key, cloudId, attachmentId: String(attachmentId), ...(download ? {download: '1'} : {})});
}
export function mediaInventory(files, references, key, cloudId, ticketUrl) {
  const attachments = files.map(file => ({
    id: String(file.id), filename: String(file.filename || 'attachment'), mimeType: file.mimeType || 'application/octet-stream', size: Number(file.size) || 0,
    previewUrl: mediaDownloadPath(key, cloudId, file.id), downloadUrl: mediaDownloadPath(key, cloudId, file.id, true), sources: [],
  }));
  const unresolved = [];
  const external = new Map();
  for (const ref of references) {
    if (ref.kind === 'external') {
      if (!external.has(ref.url)) external.set(ref.url, {...ref, sources: []});
      const item = external.get(ref.url); if (!item.sources.includes(ref.source)) item.sources.push(ref.source);
      continue;
    }
    let matches = files.map((file, index) => ({file, index})).filter(({file}) => ref.mediaId && [String(file.id), file.mediaId].includes(ref.mediaId));
    if (!matches.length && ref.filename) matches = files.map((file, index) => ({file, index})).filter(({file}) => file.filename === ref.filename);
    if (matches.length === 1) {
      const entry = attachments[matches[0].index]; if (!entry.sources.includes(ref.source)) entry.sources.push(ref.source);
    } else unresolved.push({kind: 'unresolved', mediaId: ref.mediaId, filename: ref.filename || ref.mediaId || 'Embedded media', sources: [ref.source], jiraUrl: ticketUrl, warning: 'จับคู่ media นี้กับไฟล์แนบไม่ได้แน่นอน กรุณาเปิดต้นฉบับใน Jira'});
  }
  for (const file of attachments) if (!file.sources.length) file.sources.push('Attachments');
  return {attachments, external: [...external.values()], unresolved};
}
export function inlineMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0].trim();
  return /^(image\/(?:png|jpeg|gif|webp|avif|bmp|x-icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+|application\/pdf)$/.test(mime) ? mime : null;
}
