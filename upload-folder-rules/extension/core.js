/* Shared, dependency-free rule model. A type chooses a folder; it never grants file access. */
(function (root) {
  'use strict';
  const VERSION = 1;
  const TYPES = Object.freeze({
    any: { label: '所有文件', accept: '' },
    images: { label: '图片', accept: 'image/*,.heic,.heif,.psd,.svg' },
    documents: { label: '文档', accept: '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.tex,.odt,.rtf' },
    archives: { label: '压缩包', accept: '.zip,.7z,.rar,.tar,.gz,.bz2,.xz' },
    audio: { label: '音频', accept: 'audio/*,.mp3,.wav,.flac,.m4a,.ogg,.aac,.mid,.midi' },
    video: { label: '视频', accept: 'video/*,.mp4,.mov,.mkv,.webm,.avi,.m4v' },
    custom: { label: '自定义', accept: '' }
  });
  const MIME = Object.freeze({
    '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.avif':'image/avif','.bmp':'image/bmp','.ico':'image/x-icon','.heic':'image/heic','.heif':'image/heif',
    '.pdf':'application/pdf','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.txt':'text/plain','.md':'text/markdown','.csv':'text/csv','.tex':'application/x-tex','.json':'application/json','.html':'text/html',
    '.zip':'application/zip','.7z':'application/x-7z-compressed','.rar':'application/vnd.rar','.gz':'application/gzip','.tar':'application/x-tar',
    '.mp3':'audio/mpeg','.wav':'audio/wav','.flac':'audio/flac','.m4a':'audio/mp4','.ogg':'audio/ogg','.aac':'audio/aac','.mid':'audio/midi','.midi':'audio/midi',
    '.mp4':'video/mp4','.mov':'video/quicktime','.webm':'video/webm','.mkv':'video/x-matroska','.avi':'video/x-msvideo','.m4v':'video/x-m4v'
  });
  const defaults = () => ({ version: VERSION, enabled: true, rules: [] });
  function domain(value) {
    let raw = String(value || '').trim();
    if (!raw) throw new Error('请填写网站域名，例如 example.com。');
    if (raw.startsWith('*.')) raw = raw.slice(2);
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) throw new Error('域名不能包含账户、端口或非 HTTP 地址。');
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    if (!host || host.includes('*') || host.length > 253 || /[^a-z0-9.\-\[\]:]/.test(host)) throw new Error('网站域名格式不正确。');
    if (!host.includes('.') && host !== 'localhost' && !host.startsWith('[')) throw new Error('请填写完整域名。');
    return host;
  }
  function tokens(value) {
    return [...new Set(String(value || '').toLowerCase().split(/[,\s]+/).filter(Boolean))];
  }
  function validToken(value) { return /^\.[a-z0-9][a-z0-9._+-]{0,30}$/.test(value) || /^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(value); }
  function normalizeRule(input, index = 0) {
    if (!input || typeof input !== 'object') throw new Error('规则格式不正确。');
    const type = input.type || 'any';
    if (!Object.hasOwn(TYPES, type)) throw new Error('不支持的文件类型。');
    const customAccept = tokens(input.customAccept).join(',');
    if (type === 'custom' && (!customAccept || tokens(customAccept).some(t => !validToken(t)))) throw new Error('自定义类型请填写 .pdf,.docx 或 image/* 这样的格式。');
    const host = domain(input.domain);
    const pathPrefix = String(input.pathPrefix || '/').trim();
    if (!pathPrefix.startsWith('/') || /[?#\u0000-\u001f]/.test(pathPrefix)) throw new Error('页面路径应以 / 开头，不包含 ? 或 #。');
    const id = input.id || crypto.randomUUID();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('规则编号不正确。');
    return { id, name: String(input.name || `${host} · ${TYPES[type].label}`).trim().slice(0, 100), domain: host,
      includeSubdomains: input.includeSubdomains !== false && !host.startsWith('[') && !/^\d+(\.\d+){3}$/.test(host),
      pathPrefix, type, customAccept, selector: String(input.selector || '').trim().slice(0, 500),
      enabled: input.enabled !== false, folderId: /^[a-zA-Z0-9_-]{1,64}$/.test(input.folderId || '') ? input.folderId : id,
      folderName: String(input.folderName || '').slice(0, 255), folderHint: String(input.folderHint || '').slice(0, 500), order: index };
  }
  function normalizeConfig(raw) {
    if (!raw || raw.version !== VERSION || !Array.isArray(raw.rules) || raw.rules.length > 300) throw new Error('不是可用的规则文件（版本 1，最多 300 条）。');
    const rules = raw.rules.map(normalizeRule);
    if (new Set(rules.map(r => r.id)).size !== rules.length) throw new Error('规则编号重复。');
    return { version: VERSION, enabled: raw.enabled !== false, rules };
  }
  function hostMatches(host, rule) { return host === rule.domain || (rule.includeSubdomains && host.endsWith(`.${rule.domain}`)); }
  function pathMatches(path, prefix) { return prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`); }
  function siteMatches(url, rule) {
    try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) && hostMatches(u.hostname.toLowerCase().replace(/\.$/, ''), rule) && pathMatches(u.pathname, rule.pathPrefix); } catch { return false; }
  }
  function acceptFor(rule) { return rule.type === 'custom' ? rule.customAccept : TYPES[rule.type].accept; }
  function overlap(a, b) {
    if (a === b) return true;
    const ma = a.startsWith('.') ? MIME[a] : a, mb = b.startsWith('.') ? MIME[b] : b;
    if (!ma || !mb) return false;
    return ma === mb || (ma.endsWith('/*') && mb.startsWith(ma.slice(0,-1))) || (mb.endsWith('/*') && ma.startsWith(mb.slice(0,-1)));
  }
  function candidates(config, url, input = {}) {
    if (!config.enabled) return [];
    const accepted = tokens(input.accept).filter(validToken);
    return config.rules.filter(r => r.enabled && siteMatches(url,r) && (!r.selector || input.selectorIds?.includes(r.id)))
      .map(r => ({ rule:r, typeMatch: r.type === 'any' ? 0 : accepted.length ? (tokens(acceptFor(r)).some(a => accepted.some(b => overlap(a,b))) ? 2 : -1) : 1 }))
      .filter(x => x.typeMatch >= 0)
      .sort((a,b) => b.rule.domain.length-a.rule.domain.length || b.rule.pathPrefix.length-a.rule.pathPrefix.length || Number(Boolean(b.rule.selector))-Number(Boolean(a.rule.selector)) ||
        (accepted.length ? b.typeMatch-a.typeMatch : Number(b.rule.type==='any')-Number(a.rule.type==='any')) || a.rule.order-b.rule.order)
      .map(x => x.rule);
  }
  function patterns(rule) { const host = rule.includeSubdomains ? `*.${rule.domain}` : rule.domain; return [`https://${host}/*`, `http://${host}/*`]; }
  function pickerTypes(accept) {
    const map = {};
    for (const token of tokens(accept).filter(validToken)) {
      if (token.startsWith('.')) { const mime = MIME[token] || 'application/octet-stream'; (map[mime] ||= []).push(token); }
      else { map[token] ||= []; }
    }
    return Object.keys(map).length ? [{ description: '网页或规则指定的文件类型', accept: map }] : undefined;
  }
  function acceptsFile(file, accept) {
    const list = tokens(accept).filter(validToken); if (!list.length) return true;
    const name = file.name.toLowerCase(), mime = String(file.type || MIME[`.${name.split('.').pop()}`] || '').toLowerCase();
    return list.some(t => t.startsWith('.') ? name.endsWith(t) : t.endsWith('/*') ? mime.startsWith(t.slice(0,-1)) : mime === t);
  }
  root.UFR = Object.freeze({ VERSION, TYPES, defaults, domain, tokens, normalizeRule, normalizeConfig, hostMatches, siteMatches, candidates, patterns, acceptFor, pickerTypes, acceptsFile });
})(globalThis);
