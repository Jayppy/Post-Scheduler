import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

// Configure PDF.js worker using bundled module URL supported by Vite
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

export async function extractTextFromDocument(file: File): Promise<{
  text: string;
  fileType: 'txt' | 'pdf' | 'docx';
  charCount: number;
}> {
  const lower = file.name.toLowerCase();

  if (lower.endsWith('.txt') || lower.endsWith('.md') || file.type.startsWith('text/')) {
    const text = (await file.text()).trim();
    if (!text) {
      throw new Error('The uploaded text file is empty.');
    }
    return { text, fileType: 'txt', charCount: text.length };
  }

  if (lower.endsWith('.docx') || file.type.includes('wordprocessingml')) {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    const text = result.value.trim();
    if (!text) {
      throw new Error('No readable text could be extracted from this DOCX file.');
    }
    return { text, fileType: 'docx', charCount: text.length };
  }

  if (lower.endsWith('.pdf') || file.type === 'application/pdf') {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const pages: string[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const strings = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .filter(Boolean);
      if (strings.length > 0) {
        pages.push(strings.join(' '));
      }
    }

    const text = pages.join('\n\n').trim();
    if (!text) {
      throw new Error('No selectable text found in this PDF (it may be scanned imagery).');
    }
    return { text, fileType: 'pdf', charCount: text.length };
  }

  throw new Error('Unsupported document format. Please upload a .txt, .md, .pdf, or .docx file.');
}
