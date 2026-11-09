const TS = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g;

export function srtToVtt(text) {
  const body = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\d+\s*\n(?=\d{1,2}:\d{2}:\d{2})/gm, '')
    .replace(TS, (_, h, m, s, ms) => `${h.padStart(2, '0')}:${m}:${s}.${ms.padEnd(3, '0')}`)
    .replace(/\{\\an?\d+\}/g, '')
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

export function normalizeSubtitle(text) {
  const clean = text.replace(/^﻿/, '');
  return /^WEBVTT/.test(clean.trimStart()) ? clean : srtToVtt(clean);
}

export async function decodeSubtitleBytes(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  if (!utf8.includes('�')) return utf8;
  return new TextDecoder('windows-1252').decode(buffer);
}

export function subtitleBlobUrl(text) {
  return URL.createObjectURL(new Blob([normalizeSubtitle(text)], { type: 'text/vtt' }));
}

export function guessLang(name) {
  const m = name.match(/[._-]([a-z]{2,3})(?:[._-](?:forced|sdh))?\.(?:srt|vtt)$/i);
  return m ? m[1].toLowerCase() : '';
}
