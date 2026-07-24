"use strict";

(function initLanguagePicker(root) {
  function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.map((option) => {
      if (typeof option === "string") return { value: option, label: option };
      if (!option || option.value == null) return null;
      return {
        value: String(option.value),
        label: option.label == null ? String(option.value) : String(option.label),
      };
    }).filter(Boolean);
  }

  function createLanguagePicker(config = {}) {
    const options = normalizeOptions(config.options);
    const picker = document.createElement("div");
    picker.className = "language-picker";

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "language-picker-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    if (config.ariaLabel) trigger.setAttribute("aria-label", String(config.ariaLabel));

    const valueEl = document.createElement("span");
    valueEl.className = "language-picker-value";
    const chevron = document.createElement("span");
    chevron.className = "language-picker-chevron";
    chevron.setAttribute("aria-hidden", "true");
    trigger.appendChild(valueEl);
    trigger.appendChild(chevron);

    const menu = document.createElement("div");
    menu.className = "language-picker-menu";
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-hidden", "true");
    if (config.ariaLabel) menu.setAttribute("aria-label", String(config.ariaLabel));

    const optionElements = [];
    for (const option of options) {
      const optionEl = document.createElement("button");
      optionEl.type = "button";
      optionEl.className = "language-picker-option";
      optionEl.setAttribute("role", "option");
      optionEl.setAttribute("data-lang", option.value);
      optionEl.textContent = option.label;
      menu.appendChild(optionEl);
      optionElements.push({ data: option, element: optionEl });
    }

    picker.appendChild(trigger);
    picker.appendChild(menu);

    let activeValue = "";
    let isOpen = false;
    let disposed = false;
    let changeSeq = 0;

    function findOption(value) {
      const wanted = value == null ? "" : String(value);
      return optionElements.find((entry) => entry.data.value === wanted) || null;
    }

    function paintValue(value) {
      const entry = findOption(value) || optionElements[0] || null;
      activeValue = entry ? entry.data.value : "";
      valueEl.textContent = entry ? entry.data.label : "";
      for (const item of optionElements) {
        const selected = item.data.value === activeValue;
        item.element.classList.toggle("selected", selected);
        item.element.setAttribute("aria-selected", selected ? "true" : "false");
        item.element.tabIndex = isOpen && selected ? 0 : -1;
      }
    }

    function focusElement(element) {
      if (!element || typeof element.focus !== "function") return;
      try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
    }

    function setOpen(next, { focusTrigger = false } = {}) {
      if (disposed) return;
      isOpen = !!next && optionElements.length > 0;
      picker.classList.toggle("open", isOpen);
      trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      menu.setAttribute("aria-hidden", isOpen ? "false" : "true");
      paintValue(activeValue);
      if (isOpen) {
        const selected = findOption(activeValue);
        focusElement(selected && selected.element);
      } else if (focusTrigger) {
        focusElement(trigger);
      }
    }

    function revertIfCurrent(previous, next, seq) {
      if (disposed || seq !== changeSeq || activeValue !== next) return;
      paintValue(previous);
    }

    function choose(value) {
      const entry = findOption(value);
      if (!entry) return;
      if (entry.data.value === activeValue) {
        setOpen(false, { focusTrigger: true });
        return;
      }

      const previous = activeValue;
      paintValue(entry.data.value);
      setOpen(false, { focusTrigger: true });
      const seq = ++changeSeq;
      let result;
      try {
        result = typeof config.onChange === "function"
          ? config.onChange(entry.data.value, previous)
          : undefined;
      } catch (_) {
        revertIfCurrent(previous, entry.data.value, seq);
        return;
      }
      Promise.resolve(result).then((outcome) => {
        if (outcome === false || (outcome && outcome.status === "error")) {
          revertIfCurrent(previous, entry.data.value, seq);
        }
      }, () => {
        revertIfCurrent(previous, entry.data.value, seq);
      });
    }

    function moveFocus(index, delta) {
      if (!optionElements.length) return;
      const nextIndex = (index + delta + optionElements.length) % optionElements.length;
      focusElement(optionElements[nextIndex].element);
    }

    trigger.addEventListener("click", () => setOpen(!isOpen));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        setOpen(!isOpen);
        return;
      }
      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        setOpen(false, { focusTrigger: true });
      }
    });

    for (const item of optionElements) {
      item.element.addEventListener("click", () => choose(item.data.value));
      item.element.addEventListener("keydown", (event) => {
        const index = optionElements.indexOf(item);
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false, { focusTrigger: true });
          return;
        }
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          choose(item.data.value);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(index, event.key === "ArrowDown" ? 1 : -1);
        }
      });
    }

    const closeOnOutsideClick = (event) => {
      if (!isOpen || picker.contains(event && event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (!isOpen || !event || event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false, { focusTrigger: true });
    };
    if (document && typeof document.addEventListener === "function") {
      document.addEventListener("click", closeOnOutsideClick);
      document.addEventListener("keydown", closeOnEscape);
    }

    paintValue(config.value);
    trigger.disabled = optionElements.length === 0;

    return {
      element: picker,
      setValue(value) {
        if (disposed) return;
        changeSeq++;
        paintValue(value);
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        changeSeq++;
        if (document && typeof document.removeEventListener === "function") {
          document.removeEventListener("click", closeOnOutsideClick);
          document.removeEventListener("keydown", closeOnEscape);
        }
      },
    };
  }

  root.ClawdLanguagePicker = { createLanguagePicker };
})(globalThis);
