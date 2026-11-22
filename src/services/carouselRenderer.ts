import JSZip from 'jszip';
import {
  CarouselSlide,
  DesignTheme,
  SlideAspectRatio,
  Workspace,
} from '../types/studio';

export function getDimensionsForAspect(aspect: SlideAspectRatio): { width: number; height: number } {
  switch (aspect) {
    case '1080x1080':
      return { width: 1080, height: 1080 };
    case '1080x1920':
      return { width: 1080, height: 1920 };
    case '1080x1350':
    default:
      return { width: 1080, height: 1350 };
  }
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    if (!src) {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  if (!text.trim()) return [];
  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/);
    let currentLine = '';
    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
  }
  return lines;
}

function drawCoverImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const imgRatio = img.width / img.height;
  const boxRatio = dw / dh;
  let sx = 0;
  let sy = 0;
  let sw = img.width;
  let sh = img.height;

  if (imgRatio > boxRatio) {
    sw = img.height * boxRatio;
    sx = (img.width - sw) / 2;
  } else {
    sh = img.width / boxRatio;
    sy = (img.height - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function drawGrain(ctx: CanvasRenderingContext2D, width: number, height: number, opacity: number) {
  if (opacity <= 0.005) return;
  const tileSize = 128;
  const tile = document.createElement('canvas');
  tile.width = tileSize;
  tile.height = tileSize;
  const tctx = tile.getContext('2d');
  if (!tctx) return;

  const imgData = tctx.createImageData(tileSize, tileSize);
  const data = imgData.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.floor(Math.random() * 255);
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = Math.floor(opacity * 255);
  }
  tctx.putImageData(imgData, 0, 0);

  const pattern = ctx.createPattern(tile, 'repeat');
  if (pattern) {
    ctx.save();
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }
}

export async function renderSlideToCanvas(
  slide: CarouselSlide,
  slideIndex: number,
  totalSlides: number,
  theme: DesignTheme,
  workspace: Workspace,
  aspectRatio: SlideAspectRatio
): Promise<HTMLCanvasElement> {
  if (typeof document !== 'undefined' && 'fonts' in document) {
    try {
      await document.fonts.ready;
    } catch {
      // Proceed even if font readiness rejects
    }
  }

  const { width, height } = getDimensionsForAspect(aspectRatio);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  const bgColor = slide.customBgColor || theme.colors.background;
  const accentColor = slide.customAccentColor || theme.colors.accent;
  const primaryText = theme.colors.primaryText;
  const mutedText = theme.colors.mutedText;
  const align = slide.textAlignOverride || theme.typography.alignment;

  // 1. Base background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, width, height);

  // Subtle ambient gradient depth
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, 'rgba(255,255,255,0.03)');
  grad.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // 2. Background / Band Image
  const imgSrc = slide.imageUrl || theme.layout.backgroundImageUrl || '';
  const loadedImg = imgSrc ? await loadImage(imgSrc) : null;

  if (loadedImg && theme.layout.imagePlacement !== 'none') {
    ctx.save();
    if (theme.layout.imagePlacement === 'background-scrim') {
      drawCoverImage(ctx, loadedImg, 0, 0, width, height);
      ctx.fillStyle = `rgba(6, 6, 9, ${theme.layout.scrimOpacity})`;
      ctx.fillRect(0, 0, width, height);
    } else if (theme.layout.imagePlacement === 'top-band') {
      const bandH = Math.round(height * 0.34);
      drawCoverImage(ctx, loadedImg, 64, 128, width - 128, bandH);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.strokeRect(64, 128, width - 128, bandH);
    } else if (theme.layout.imagePlacement === 'bottom-band') {
      const bandH = Math.round(height * 0.32);
      const bandY = height - bandH - 110;
      drawCoverImage(ctx, loadedImg, 64, bandY, width - 128, bandH);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.strokeRect(64, bandY, width - 128, bandH);
    } else if (theme.layout.imagePlacement === 'split-right') {
      const splitW = Math.round(width * 0.42);
      drawCoverImage(ctx, loadedImg, width - splitW, 0, splitW, height);
      const splitGrad = ctx.createLinearGradient(width - splitW, 0, width - splitW + 80, 0);
      splitGrad.addColorStop(0, bgColor);
      splitGrad.addColorStop(1, 'rgba(0,0,0,0.15)');
      ctx.fillStyle = splitGrad;
      ctx.fillRect(width - splitW, 0, splitW, height);
    }
    ctx.restore();
  }

  // 3. Film grain
  drawGrain(ctx, width, height, theme.layout.grainOpacity);

  // 4. Decorative frame & editorial rules
  const padX = 88;
  const padY = 88;
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.lineWidth = 1.5;

  if (theme.layout.decorativeStyle === 'hairline-frame') {
    ctx.strokeRect(44, 44, width - 88, height - 88);
  } else if (theme.layout.decorativeStyle === 'editorial-rule') {
    ctx.beginPath();
    ctx.moveTo(padX, 118);
    ctx.lineTo(width - padX, 118);
    ctx.moveTo(padX, height - 118);
    ctx.lineTo(width - padX, height - 118);
    ctx.stroke();
  } else if (theme.layout.decorativeStyle === 'grid-ticks') {
    const tick = 22;
    const corners = [
      [44, 44],
      [width - 44, 44],
      [44, height - 44],
      [width - 44, height - 44],
    ];
    for (const [cx, cy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx === 44 ? cx : cx - tick, cy);
      ctx.lineTo(cx === 44 ? cx + tick : cx, cy);
      ctx.moveTo(cx, cy === 44 ? cy : cy - tick);
      ctx.lineTo(cx, cy === 44 ? cy + tick : cy);
      ctx.stroke();
    }
  } else if (theme.layout.decorativeStyle === 'geometric-corner') {
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(52, 120);
    ctx.lineTo(52, 52);
    ctx.lineTo(120, 52);
    ctx.moveTo(width - 120, height - 52);
    ctx.lineTo(width - 52, height - 52);
    ctx.lineTo(width - 52, height - 120);
    ctx.stroke();
  }
  ctx.restore();

  // 5. Logo & Slide Numbers
  const logoImg = workspace.logoDataUrl ? await loadImage(workspace.logoDataUrl) : null;
  const brandLabel = workspace.watermarkText || workspace.name.toUpperCase();
  const slideCounterText = `${String(slideIndex + 1).padStart(2, '0')} / ${String(totalSlides).padStart(2, '0')}`;

  ctx.save();
  ctx.font = `600 22px "JetBrains Mono", monospace`;
  ctx.fillStyle = mutedText;
  ctx.textBaseline = 'middle';

  const drawLogoAt = (x: number, y: number, textAlign: CanvasTextAlign) => {
    if (logoImg) {
      const targetH = 44;
      const targetW = (logoImg.width / logoImg.height) * targetH;
      const drawX = textAlign === 'right' ? x - targetW : x;
      ctx.drawImage(logoImg, drawX, y - targetH / 2, targetW, targetH);
    } else {
      ctx.textAlign = textAlign;
      ctx.fillStyle = primaryText;
      ctx.font = `700 24px "${theme.typography.headingFont}", sans-serif`;
      ctx.fillText(brandLabel, x, y);
    }
  };

  if (theme.layout.logoPlacement === 'top-left') {
    drawLogoAt(padX, 82, 'left');
    if (theme.layout.showSlideNumbers) {
      ctx.textAlign = 'right';
      ctx.fillStyle = mutedText;
      ctx.font = `500 21px "JetBrains Mono", monospace`;
      ctx.fillText(slideCounterText, width - padX, 82);
    }
  } else if (theme.layout.logoPlacement === 'top-right') {
    drawLogoAt(width - padX, 82, 'right');
    if (theme.layout.showSlideNumbers) {
      ctx.textAlign = 'left';
      ctx.fillStyle = mutedText;
      ctx.font = `500 21px "JetBrains Mono", monospace`;
      ctx.fillText(slideCounterText, padX, 82);
    }
  } else if (theme.layout.logoPlacement === 'bottom-left') {
    drawLogoAt(padX, height - 82, 'left');
    if (theme.layout.showSlideNumbers) {
      ctx.textAlign = 'right';
      ctx.fillStyle = mutedText;
      ctx.font = `500 21px "JetBrains Mono", monospace`;
      ctx.fillText(slideCounterText, width - padX, 82);
    }
  } else if (theme.layout.logoPlacement === 'bottom-right') {
    drawLogoAt(width - padX, height - 82, 'right');
    if (theme.layout.showSlideNumbers) {
      ctx.textAlign = 'left';
      ctx.fillStyle = mutedText;
      ctx.font = `500 21px "JetBrains Mono", monospace`;
      ctx.fillText(slideCounterText, padX, 82);
    }
  } else if (theme.layout.showSlideNumbers) {
    ctx.textAlign = 'right';
    ctx.fillStyle = mutedText;
    ctx.font = `500 21px "JetBrains Mono", monospace`;
    ctx.fillText(slideCounterText, width - padX, 82);
  }
  ctx.restore();

  // 6. Content Safe Zone calculation (prevent overflow or clipping)
  let contentTop = 165;
  let contentBottom = height - 155;
  let contentWidth = width - padX * 2;

  if (loadedImg && theme.layout.imagePlacement === 'top-band') {
    contentTop = 128 + Math.round(height * 0.34) + 52;
  } else if (loadedImg && theme.layout.imagePlacement === 'bottom-band') {
    contentBottom = height - Math.round(height * 0.32) - 150;
  } else if (loadedImg && theme.layout.imagePlacement === 'split-right') {
    contentWidth = Math.round(width * 0.54) - padX;
  }

  const availableH = Math.max(280, contentBottom - contentTop);
  const anchorX =
    align === 'center'
      ? padX + contentWidth / 2
      : align === 'right'
        ? padX + contentWidth
        : padX;

  ctx.save();
  ctx.textAlign = align;
  ctx.textBaseline = 'top';

  // Auto-scale text down cleanly if combined height exceeds safe zone
  let scale = 1.0;
  let kickerLines: string[] = [];
  let headlineLines: string[] = [];
  let bodyLines: string[] = [];
  let highlightLines: string[] = [];
  let headFontSize = theme.typography.headingSize;
  let bodyFontSize = theme.typography.bodySize;
  let kickerFontSize = 22;
  let highlightFontSize = 24;
  let totalContentH = 0;

  for (let attempt = 0; attempt < 8; attempt++) {
    headFontSize = Math.round((slide.layoutVariant === 'hero-center' ? theme.typography.headingSize * 1.15 : theme.typography.headingSize) * scale);
    bodyFontSize = Math.round(theme.typography.bodySize * scale);
    kickerFontSize = Math.round(21 * Math.max(0.8, scale));
    highlightFontSize = Math.round(24 * Math.max(0.8, scale));

    ctx.font = `600 ${kickerFontSize}px "JetBrains Mono", monospace`;
    kickerLines = slide.kicker ? wrapLines(ctx, slide.kicker.toUpperCase(), contentWidth) : [];

    ctx.font = `700 ${headFontSize}px "${theme.typography.headingFont}", sans-serif`;
    headlineLines = wrapLines(ctx, slide.headline, contentWidth);

    ctx.font = `400 ${bodyFontSize}px "${theme.typography.bodyFont}", sans-serif`;
    bodyLines = wrapLines(ctx, slide.body, contentWidth);

    ctx.font = `600 ${highlightFontSize}px "${theme.typography.bodyFont}", sans-serif`;
    highlightLines = slide.highlight ? wrapLines(ctx, slide.highlight, contentWidth - 40) : [];

    const kickerH = kickerLines.length * (kickerFontSize * 1.35) + (kickerLines.length ? 22 : 0);
    const headH = headlineLines.length * (headFontSize * 1.15) + 28;
    const bodyH = bodyLines.length * (bodyFontSize * 1.52) + (bodyLines.length ? 30 : 0);
    const highH = highlightLines.length ? highlightLines.length * (highlightFontSize * 1.45) + 40 : 0;

    totalContentH = kickerH + headH + bodyH + highH;
    if (totalContentH <= availableH) break;
    scale -= 0.09;
  }

  let cursorY =
    slide.layoutVariant === 'hero-center' || slide.layoutVariant === 'quote-card' || slide.layoutVariant === 'cta-end'
      ? contentTop + Math.max(0, (availableH - totalContentH) / 2)
      : contentTop + Math.max(0, (availableH - totalContentH) * 0.25);

  // Draw Kicker
  if (kickerLines.length > 0) {
    ctx.font = `600 ${kickerFontSize}px "JetBrains Mono", monospace`;
    ctx.fillStyle = accentColor;
    for (const line of kickerLines) {
      ctx.fillText(line, anchorX, cursorY);
      cursorY += kickerFontSize * 1.35;
    }
    cursorY += 22;
  }

  // Draw Headline
  ctx.font = `700 ${headFontSize}px "${theme.typography.headingFont}", sans-serif`;
  ctx.fillStyle = primaryText;
  for (const line of headlineLines) {
    ctx.fillText(line, anchorX, cursorY);
    cursorY += headFontSize * 1.15;
  }

  // Subtle accent divider bar under headline
  cursorY += 12;
  ctx.fillStyle = accentColor;
  const barW = 72;
  const barX =
    align === 'center' ? anchorX - barW / 2 : align === 'right' ? anchorX - barW : anchorX;
  ctx.fillRect(barX, cursorY, barW, 3);
  cursorY += 24;

  // Draw Body
  if (bodyLines.length > 0) {
    ctx.font = `400 ${bodyFontSize}px "${theme.typography.bodyFont}", sans-serif`;
    ctx.fillStyle = mutedText;
    for (const line of bodyLines) {
      ctx.fillText(line, anchorX, cursorY);
      cursorY += bodyFontSize * 1.52;
    }
    cursorY += 24;
  }

  // Draw Highlight Callout Box
  if (highlightLines.length > 0) {
    const boxH = highlightLines.length * (highlightFontSize * 1.45) + 32;
    const boxW = Math.min(contentWidth, 780);
    const boxX =
      align === 'center' ? anchorX - boxW / 2 : align === 'right' ? anchorX - boxW : anchorX;

    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.fillRect(boxX, cursorY, boxW, boxH);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(boxX, cursorY, boxW, boxH);

    ctx.font = `600 ${highlightFontSize}px "${theme.typography.bodyFont}", sans-serif`;
    ctx.fillStyle = primaryText;
    let hy = cursorY + 16;
    const textAnchor =
      align === 'center' ? boxX + boxW / 2 : align === 'right' ? boxX + boxW - 22 : boxX + 22;
    for (const line of highlightLines) {
      ctx.fillText(line, textAnchor, hy);
      hy += highlightFontSize * 1.45;
    }
  }

  ctx.restore();

  // Footer swipe prompt on non-final slides
  if (slideIndex < totalSlides - 1) {
    ctx.save();
    ctx.font = `500 18px "JetBrains Mono", monospace`;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('SWIPE →', width - padX, height - 74);
    ctx.restore();
  }

  return canvas;
}

export async function renderSlideToPngBlob(
  slide: CarouselSlide,
  slideIndex: number,
  totalSlides: number,
  theme: DesignTheme,
  workspace: Workspace,
  aspectRatio: SlideAspectRatio
): Promise<Blob> {
  const canvas = await renderSlideToCanvas(
    slide,
    slideIndex,
    totalSlides,
    theme,
    workspace,
    aspectRatio
  );
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode PNG slide.'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

export async function exportAllSlidesToPngBlobs(
  slides: CarouselSlide[],
  theme: DesignTheme,
  workspace: Workspace,
  aspectRatio: SlideAspectRatio,
  onProgress?: (completed: number, total: number) => void
): Promise<Array<{ slideNumber: number; filename: string; blob: Blob }>> {
  const results: Array<{ slideNumber: number; filename: string; blob: Blob }> = [];
  for (let i = 0; i < slides.length; i++) {
    const blob = await renderSlideToPngBlob(
      slides[i],
      i,
      slides.length,
      theme,
      workspace,
      aspectRatio
    );
    const num = String(i + 1).padStart(2, '0');
    results.push({
      slideNumber: i + 1,
      filename: `${num}_slide.png`,
      blob,
    });
    onProgress?.(i + 1, slides.length);
  }
  return results;
}

export async function packagePngSlidesToZip(
  slides: Array<{ filename: string; blob: Blob }>
): Promise<Blob> {
  const zip = new JSZip();
  for (const item of slides) {
    zip.file(item.filename, item.blob);
  }
  return zip.generateAsync({ type: 'blob' });
}

export function computeCarouselExportHash(
  projectId: string,
  themeId: string,
  aspectRatio: SlideAspectRatio,
  slides: CarouselSlide[]
): string {
  const signature = JSON.stringify({
    projectId,
    themeId,
    aspectRatio,
    slides: slides.map((s) => ({
      k: s.kicker,
      h: s.headline,
      b: s.body,
      hl: s.highlight,
      lv: s.layoutVariant,
      img: s.imageUrl,
      bg: s.customBgColor,
      ac: s.customAccentColor,
    })),
  });

  let hash = 0;
  for (let i = 0; i < signature.length; i++) {
    const chr = signature.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return `car-${Math.abs(hash).toString(36)}`;
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
