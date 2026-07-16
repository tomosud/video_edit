// titlePositionEditor.js - drag/reset a selected Title caption independently per layout
import { store } from './store.js';

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function createTitlePositionEditor({ canvas, resetButton, layout } = {}) {
  let activeBounds = null;
  let activeCaptionId = null;
  let drag = null;

  const selectedTitle = () => {
    const id = store.ui.selectedCaptionId;
    if (!id) return null;
    for (const output of store.get().outputs || []) {
      const caption = (output.captions || []).find(row => row.id === id);
      if (caption) return caption.kind === 'title' ? caption : null;
    }
    return null;
  };

  const pointAt = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / Math.max(1, rect.width) * canvas.width,
      y: (event.clientY - rect.top) / Math.max(1, rect.height) * canvas.height,
    };
  };

  const hitsTitle = (point) => {
    if (!activeBounds) return false;
    const pad = Math.max(8, Math.min(canvas.width, canvas.height) * 0.012);
    return point.x >= activeBounds.x - pad && point.x <= activeBounds.x + activeBounds.width + pad &&
      point.y >= activeBounds.y - pad && point.y <= activeBounds.y + activeBounds.height + pad;
  };

  const moveTitle = (event) => {
    if (!drag || !canvas.width || !canvas.height) return;
    const point = pointAt(event);
    const halfX = Math.min(0.5, drag.width / 2 / canvas.width);
    const halfY = Math.min(0.5, drag.height / 2 / canvas.height);
    const x = clamp((point.x - drag.offsetX) / canvas.width, halfX, 1 - halfX);
    const y = clamp((point.y - drag.offsetY) / canvas.height, halfY, 1 - halfY);
    store.updateLive((project) => {
      const caption = findCaption(project, drag.captionId);
      if (!caption || caption.kind !== 'title') return;
      caption.titlePosition = { ...(caption.titlePosition || {}) };
      caption.titlePosition[layout] = { x, y };
    });
  };

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || !activeCaptionId || !hitsTitle(pointAt(event))) return;
    event.preventDefault();
    event.stopPropagation();
    const point = pointAt(event);
    drag = {
      captionId: activeCaptionId,
      pointerId: event.pointerId,
      offsetX: point.x - (activeBounds.x + activeBounds.width / 2),
      offsetY: point.y - (activeBounds.y + activeBounds.height / 2),
      width: activeBounds.width,
      height: activeBounds.height,
    };
    store.beginAction();
    canvas.classList.add('title-position-dragging');
    try { canvas.setPointerCapture(event.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (event) => {
    if (drag) {
      event.preventDefault();
      moveTitle(event);
      return;
    }
    canvas.classList.toggle('title-position-hover', !!activeCaptionId && hitsTitle(pointAt(event)));
  });
  canvas.addEventListener('pointerleave', () => {
    if (!drag) canvas.classList.remove('title-position-hover');
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag) return;
    try { canvas.releasePointerCapture(drag.pointerId); } catch { /* ignore */ }
    drag = null;
    canvas.classList.remove('title-position-dragging');
  });
  canvas.addEventListener('pointercancel', () => {
    drag = null;
    canvas.classList.remove('title-position-dragging');
  });
  canvas.addEventListener('dblclick', (event) => {
    if (!activeCaptionId || !hitsTitle(pointAt(event))) return;
    event.preventDefault();
    event.stopPropagation();
  });

  resetButton?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const caption = selectedTitle();
    if (!caption) return;
    store.update((project) => {
      const current = findCaption(project, caption.id);
      if (!current?.titlePosition) return;
      delete current.titlePosition[layout];
      if (!Object.keys(current.titlePosition).length) delete current.titlePosition;
    });
  });
  resetButton?.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  return {
    update(drawResult, text) {
      const selected = selectedTitle();
      const active = !!selected && text?.captionId === selected.id && drawResult?.kind === 'title';
      activeCaptionId = active ? selected.id : null;
      activeBounds = active ? drawResult.bounds : null;
      canvas.classList.toggle('title-position-editable', active);
      if (!active) canvas.classList.remove('title-position-hover');
      if (resetButton) {
        resetButton.hidden = !active;
        resetButton.disabled = !selected?.titlePosition?.[layout];
      }
    },
  };
}

function findCaption(project, id) {
  for (const output of project?.outputs || []) {
    const caption = (output.captions || []).find(row => row.id === id);
    if (caption) return caption;
  }
  return null;
}
