"use strict";

(function initRoamFencePicker() {
  const STRINGS = {
    en: { title: "Choose Clawd's activity area", hint: "First drag to draw a new area. After you release, drag inside to move it or drag an edge or corner to resize. The whole pet must fit inside it on this display.", confirm: "Use this area", cancel: "Cancel", tooSmall: "Too small" },
    zh: { title: "框选 Clawd 的活动范围", hint: "先拖出一个新范围；松开后，可拖动框内移动选区，也可拖动边缘或角点调整大小。范围必须能在当前屏幕放下整个桌宠。", confirm: "使用此范围", cancel: "取消", tooSmall: "范围太小" },
    "zh-TW": { title: "框選 Clawd 的活動範圍", hint: "先拖出一個新範圍；放開後，可拖曳框內移動選區，也可拖曳邊緣或角點調整大小。範圍必須能在目前螢幕容納完整桌寵。", confirm: "使用此範圍", cancel: "取消", tooSmall: "範圍太小" },
    ko: { title: "Clawd 활동 영역 선택", hint: "먼저 드래그해 새 영역을 그리세요. 놓은 뒤에는 영역 안을 드래그해 이동하거나 가장자리와 모서리를 드래그해 크기를 조절할 수 있습니다. 이 디스플레이에서 펫 전체가 들어가야 합니다.", confirm: "이 영역 사용", cancel: "취소", tooSmall: "영역이 너무 작음" },
    ja: { title: "Clawd の活動範囲を選択", hint: "まずドラッグして新しい範囲を描きます。離した後は、範囲内をドラッグして移動したり、辺や角をドラッグしてサイズを変更できます。このディスプレイでペット全体が収まる必要があります。", confirm: "この範囲を使う", cancel: "キャンセル", tooSmall: "範囲が小さすぎます" },
  };
  const api = window.roamFencePickerAPI;
  const geometry = window.roamFencePickerGeometry;
  const selectionElement = document.getElementById("selection");
  const sizeElement = document.getElementById("selection-size");
  const titleElement = document.getElementById("title");
  const hintElement = document.getElementById("hint");
  const confirmButton = document.getElementById("confirm");
  const cancelButton = document.getElementById("cancel");
  let context = null;
  let strings = STRINGS.en;
  let selection = null;
  let start = null;
  let initialSelection = null;
  let dragMode = "draw";
  let dragging = false;
  let activePointerId = null;

  function isSelectionValid() {
    return !!selection && !!context
      && selection.width >= context.minimumSize.width
      && selection.height >= context.minimumSize.height;
  }

  function renderSelection() {
    if (!selection) {
      selectionElement.style.display = "none";
      confirmButton.disabled = true;
      return;
    }
    selectionElement.style.display = "block";
    selectionElement.style.left = `${selection.x}px`;
    selectionElement.style.top = `${selection.y}px`;
    selectionElement.style.width = `${selection.width}px`;
    selectionElement.style.height = `${selection.height}px`;
    selectionElement.classList.toggle("editing", !dragging || dragMode !== "draw");
    const valid = isSelectionValid();
    selectionElement.classList.toggle("invalid", !valid);
    sizeElement.textContent = valid
      ? `${Math.round(selection.width)} × ${Math.round(selection.height)}`
      : `${strings.tooSmall} · ${Math.round(selection.width)} × ${Math.round(selection.height)}`;
    confirmButton.disabled = !valid;
  }

  function pointerPoint(event) {
    return {
      x: Math.min(Math.round(context.workArea.width), Math.max(0, Math.round(event.clientX))),
      y: Math.min(Math.round(context.workArea.height), Math.max(0, Math.round(event.clientY))),
    };
  }

  function updateFromPoint(point) {
    selection = geometry.updateSelection(
      dragMode,
      start,
      point,
      initialSelection,
      context.workArea,
    );
    renderSelection();
  }

  function updateHoverCursor(point) {
    const mode = geometry.hitTestSelection(selection, point);
    document.body.style.cursor = geometry.cursorForMode(mode);
  }

  function finishPointerInteraction(event, updateFinalPoint = true) {
    if (!dragging || activePointerId === null || event.pointerId !== activePointerId) return;
    const pointerId = activePointerId;
    const point = context ? pointerPoint(event) : null;
    if (updateFinalPoint && start && point) updateFromPoint(point);
    dragging = false;
    activePointerId = null;
    start = null;
    initialSelection = null;
    try { document.body.releasePointerCapture(pointerId); } catch {}
    renderSelection();
    if (point) updateHoverCursor(point);
  }

  document.body.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!context || event.button !== 0
      || (target && typeof target.closest === "function" && target.closest("#actions"))) return;
    if (activePointerId !== null) {
      if (event.pointerId !== activePointerId) return;
      // Recover if an earlier stream lost its terminal event. A fresh down from
      // the same physical mouse is authoritative and starts a new transaction.
      finishPointerInteraction(event, false);
    }
    dragging = true;
    activePointerId = event.pointerId;
    start = pointerPoint(event);
    initialSelection = selection ? { ...selection } : null;
    dragMode = geometry.hitTestSelection(selection, start);
    selection = geometry.updateSelection(dragMode, start, start, initialSelection, context.workArea);
    document.body.style.cursor = geometry.cursorForMode(dragMode);
    try { document.body.setPointerCapture(event.pointerId); } catch {}
    renderSelection();
  });
  document.body.addEventListener("pointermove", (event) => {
    if (!context) return;
    const point = pointerPoint(event);
    if (!dragging || !start) { updateHoverCursor(point); return; }
    if (event.pointerId !== activePointerId) return;
    updateFromPoint(point);
  });
  document.body.addEventListener("pointerup", (event) => finishPointerInteraction(event));
  // A normal capture release also emits lostpointercapture, sometimes after a
  // new mouse gesture has already reused the same pointerId. Treating that
  // delayed event as cancellation can roll the new drag back to its start.
  // pointercancel is the authoritative interruption signal; keep the last
  // visible rectangle instead of surprising the user with an undo.
  document.body.addEventListener("pointercancel", (event) => finishPointerInteraction(event, false));
  confirmButton.addEventListener("click", () => {
    if (isSelectionValid()) api.confirm(selection);
  });
  cancelButton.addEventListener("click", () => api.cancel());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      api.cancel();
      return;
    }
    const target = event.target;
    const nativeButtonAction = target && typeof target.closest === "function" && target.closest("button");
    if (event.key === "Enter" && !dragging && !nativeButtonAction && isSelectionValid()) {
      event.preventDefault();
      api.confirm(selection);
    }
  });

  api.onState((nextContext) => {
    context = nextContext;
    strings = STRINGS[context.lang] || STRINGS.en;
    document.documentElement.lang = context.lang;
    titleElement.textContent = strings.title;
    hintElement.textContent = strings.hint;
    confirmButton.textContent = strings.confirm;
    cancelButton.textContent = strings.cancel;
    dragging = false;
    activePointerId = null;
    start = null;
    initialSelection = null;
    selection = null;
    renderSelection();
    document.body.style.cursor = "crosshair";
  });
  api.ready();
})();
