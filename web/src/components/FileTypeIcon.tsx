import {
  BsFiletypeAac, BsFiletypeAi, BsFiletypeBmp, BsFiletypeCs, BsFiletypeCss, BsFiletypeCsv,
  BsFiletypeDoc, BsFiletypeDocx, BsFiletypeExe, BsFiletypeGif, BsFiletypeHeic, BsFiletypeHtml,
  BsFiletypeJava, BsFiletypeJpg, BsFiletypeJs, BsFiletypeJson, BsFiletypeJsx, BsFiletypeMd,
  BsFiletypeMdx, BsFiletypeMov, BsFiletypeMp3, BsFiletypeMp4, BsFiletypePdf, BsFiletypePhp,
  BsFiletypePng, BsFiletypePpt, BsFiletypePptx, BsFiletypePy, BsFiletypeRb, BsFiletypeSass,
  BsFiletypeScss, BsFiletypeSh, BsFiletypeSql, BsFiletypeSvg, BsFiletypeTiff, BsFiletypeTsx,
  BsFiletypeTxt, BsFiletypeXls, BsFiletypeXlsx, BsFiletypeXml, BsFiletypeYml,
} from 'react-icons/bs';
import type { IconType } from 'react-icons';
import { FileCodeIcon, FileIcon, FileSpreadsheetIcon, FileTextIcon, ImageIcon } from 'lucide-react';
import { fileExt, previewKind, type PreviewKind } from '@/lib/files';

/** Per-extension icons that have a real Bootstrap "Filetype" glyph (the type
 *  name is baked into the icon, so XLSX/DOCX/PY/… read at a glance). Aliases map
 *  to the closest available glyph. */
const BY_EXT: Record<string, IconType> = {
  pdf: BsFiletypePdf,
  doc: BsFiletypeDoc, docx: BsFiletypeDocx,
  xls: BsFiletypeXls, xlsx: BsFiletypeXlsx, xlsm: BsFiletypeXlsx,
  ppt: BsFiletypePpt, pptx: BsFiletypePptx,
  csv: BsFiletypeCsv, tsv: BsFiletypeCsv,
  txt: BsFiletypeTxt, text: BsFiletypeTxt, log: BsFiletypeTxt,
  md: BsFiletypeMd, markdown: BsFiletypeMd, mdx: BsFiletypeMdx,
  json: BsFiletypeJson,
  xml: BsFiletypeXml,
  yml: BsFiletypeYml, yaml: BsFiletypeYml,
  html: BsFiletypeHtml, htm: BsFiletypeHtml,
  css: BsFiletypeCss, scss: BsFiletypeScss, sass: BsFiletypeSass,
  js: BsFiletypeJs, mjs: BsFiletypeJs, cjs: BsFiletypeJs,
  jsx: BsFiletypeJsx, ts: BsFiletypeTsx, tsx: BsFiletypeTsx,
  py: BsFiletypePy,
  java: BsFiletypeJava, cs: BsFiletypeCs,
  php: BsFiletypePhp, rb: BsFiletypeRb,
  sh: BsFiletypeSh, bash: BsFiletypeSh, zsh: BsFiletypeSh,
  sql: BsFiletypeSql,
  png: BsFiletypePng, jpg: BsFiletypeJpg, jpeg: BsFiletypeJpg, gif: BsFiletypeGif,
  svg: BsFiletypeSvg, bmp: BsFiletypeBmp, tiff: BsFiletypeTiff, tif: BsFiletypeTiff,
  heic: BsFiletypeHeic, ai: BsFiletypeAi,
  mp3: BsFiletypeMp3, aac: BsFiletypeAac, wav: BsFiletypeAac,
  mp4: BsFiletypeMp4, mov: BsFiletypeMov,
  exe: BsFiletypeExe,
};

/** Generic lucide fallback when no extension-specific glyph exists. */
function fallback(kind: PreviewKind): IconType {
  if (kind === 'excel' || kind === 'csv') return FileSpreadsheetIcon;
  if (kind === 'code') return FileCodeIcon;
  if (kind === 'image') return ImageIcon;
  if (kind === 'word' || kind === 'pdf' || kind === 'markdown' || kind === 'text') return FileTextIcon;
  return FileIcon;
}

/** Resolve the best icon for a file: the extension-specific Bootstrap glyph if
 *  one exists, otherwise a generic lucide icon for the preview kind. */
export function FileTypeIcon({ path, mime, className }: { path: string; mime?: string; className?: string }) {
  const Icon = BY_EXT[fileExt(path)] ?? fallback(previewKind(path, mime));
  return <Icon className={className} />;
}
