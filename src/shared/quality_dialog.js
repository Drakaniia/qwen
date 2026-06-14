(function attachQwinQualityDialog(root, factory) {
  const qualityDialog = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = qualityDialog;
  }
  root.QwinQualityDialog = qualityDialog;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQwinQualityDialog() {
  "use strict";

  const DEFAULT_LOADING_TEXT = "Checking available video versions...";
  const DEFAULT_CHOICES = [{ id: "best", label: "Best available MP4" }];

  function setVisible(element, visible, displayValue = "block") {
    if (!element) {
      return;
    }
    if ("hidden" in element) {
      element.hidden = !visible;
      return;
    }
    element.style.display = visible ? displayValue : "none";
  }

  function showRoot(root, options) {
    if (typeof options.showRoot === "function") {
      return options.showRoot(root);
    }
    root.hidden = false;
    return undefined;
  }

  function hideRoot(root, options) {
    if (typeof options.hideRoot === "function") {
      return options.hideRoot(root);
    }
    root.hidden = true;
    return undefined;
  }

  function formatters(options) {
    const qualityFormat = options.qualityFormat || {};
    return {
      bitrate: (format) => qualityFormat.formatBitrateValue(format),
      format: (format) => qualityFormat.formatFormatValue(format),
      quality: (format) => qualityFormat.formatQualityValue(format),
      size: (format) => qualityFormat.formatSizeValue(format, options.videoFilters || null),
      source: (format) => qualityFormat.formatSourceValue(format),
    };
  }

  function applyInlineCellStyle(cell, primary) {
    cell.style.minWidth = "0";
    cell.style.overflowWrap = "anywhere";
    cell.style.fontSize = "11px";
    cell.style.lineHeight = "1.25";
    if (primary) {
      cell.style.fontWeight = "800";
      cell.style.color = "#171b22";
    }
  }

  function applyInlineRowStyle(row) {
    row.style.display = "grid";
    row.style.gridTemplateColumns = "1fr 0.78fr 0.68fr 0.82fr 1.18fr";
    row.style.gap = "7px";
    row.style.alignItems = "center";
  }

  function applyInlineTableStyle(table) {
    table.style.display = "grid";
    table.style.gap = "6px";
    table.style.minWidth = "520px";
  }

  function createCell(document, row, value, primary, useClasses) {
    const cell = document.createElement("span");
    cell.textContent = value || "Unknown";
    if (useClasses) {
      cell.className = `quality-cell ${primary ? "primary-cell" : ""}`.trim();
    } else {
      applyInlineCellStyle(cell, primary);
    }
    row.append(cell);
  }

  function createHeader(document, table, useClasses) {
    const header = document.createElement("div");
    if (useClasses) {
      header.className = "quality-row quality-header";
      header.setAttribute("role", "row");
    } else {
      applyInlineRowStyle(header);
      header.style.padding = "0 8px";
      header.style.color = "#687386";
      header.style.font = "800 10px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      header.style.textTransform = "uppercase";
    }

    for (const label of ["Quality", "Size", "Format", "Bitrate", "Source"]) {
      createCell(document, header, label, false, useClasses);
    }
    table.append(header);
  }

  function selectedFormat(button) {
    return {
      formatId: button.dataset.formatId || "best",
      variantId: button.dataset.variantId || "",
      backend: button.dataset.backend || "auto",
    };
  }

  function createChooser(options) {
    const document = options.document || options.root.ownerDocument;
    const root = options.root;
    const title = options.title;
    const list = options.list;
    const cancel = options.cancel;
    const back = options.back || null;
    const useClasses = options.style === "classes";
    const hideOnSelect = options.hideOnSelect !== false;
    const hideOnBack = options.hideOnBack === true;
    const formatter = formatters(options);
    let loadingElement = null;
    let pendingResolve = null;

    function clearPending(value, shouldHide) {
      const resolve = pendingResolve;
      pendingResolve = null;
      if (shouldHide) {
        hide();
      } else if (back) {
        setVisible(back, false);
      }
      if (resolve) {
        resolve(value);
      }
    }

    function resetActions() {
      if (back) {
        setVisible(back, false);
        back.onclick = null;
      }
      cancel.disabled = false;
      cancel.textContent = "Cancel";
      cancel.onclick = null;
    }

    function hide() {
      hideRoot(root, options);
      list.textContent = "";
      loadingElement = null;
      resetActions();
    }

    function showLoading({ loadingTitle = "Loading versions...", statusText = DEFAULT_LOADING_TEXT, onCancel } = {}) {
      pendingResolve = null;
      title.textContent = loadingTitle;
      list.textContent = "";
      resetActions();

      const loading = document.createElement("div");
      loadingElement = loading;
      if (options.loadingStatusId) {
        loading.id = options.loadingStatusId;
      }
      loading.textContent = statusText;

      if (useClasses) {
        loading.className = "quality-loading";
      } else {
        loading.style.minHeight = "48px";
        loading.style.display = "grid";
        loading.style.placeItems = "center";
        loading.style.padding = "12px";
        loading.style.border = "1px solid #dce1e8";
        loading.style.borderRadius = "6px";
        loading.style.background = "#eef7f5";
        loading.style.color = "#0b5e58";
        loading.style.font = "750 12px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
      }

      list.append(loading);
      cancel.onclick = () => {
        if (typeof onCancel === "function") {
          onCancel();
        }
        hide();
      };
      showRoot(root, options);
    }

    function updateLoadingStatus(statusText) {
      if (loadingElement) {
        loadingElement.textContent = statusText;
      }
    }

    function showChoices({ choiceTitle = "", formats = [], nativeError = "", hasBack = false } = {}) {
      return new Promise((resolve) => {
        pendingResolve = resolve;
        title.textContent = choiceTitle ? `Compare versions: ${choiceTitle}` : "Compare versions";
        list.textContent = "";
        loadingElement = null;
        resetActions();

        if (hasBack && back) {
          setVisible(back, true);
          back.onclick = () => clearPending(null, hideOnBack);
        }

        const choices = formats && formats.length ? formats : DEFAULT_CHOICES;
        const table = document.createElement("div");
        if (useClasses) {
          table.className = "quality-table";
          table.setAttribute("role", "table");
        } else {
          applyInlineTableStyle(table);
        }
        createHeader(document, table, useClasses);

        for (const format of choices) {
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.formatId = format.formatId || format.id || "best";
          button.dataset.variantId = format.variantId || "";
          button.dataset.backend = format.backend || "auto";
          button.title = format.sourceUrl || format.label || "";

          if (useClasses) {
            button.className = "quality-row quality-option";
            button.setAttribute("role", "row");
          } else {
            applyInlineRowStyle(button);
            button.style.minHeight = "34px";
            button.style.padding = "7px 9px";
            button.style.border = "1px solid #dce1e8";
            button.style.borderRadius = "6px";
            button.style.background = "#fff";
            button.style.color = "#171b22";
            button.style.textAlign = "left";
            button.style.font = "600 13px system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
            button.style.cursor = "pointer";
          }

          createCell(document, button, formatter.quality(format), true, useClasses);
          createCell(document, button, formatter.size(format), false, useClasses);
          createCell(document, button, formatter.format(format), false, useClasses);
          createCell(document, button, formatter.bitrate(format), false, useClasses);
          createCell(document, button, formatter.source(format), false, useClasses);
          button.addEventListener("click", () => clearPending(selectedFormat(button), hideOnSelect));
          table.append(button);
        }

        list.append(table);
        if (nativeError) {
          const note = document.createElement("div");
          note.textContent = nativeError;
          if (useClasses) {
            note.className = "quality-note";
          } else {
            note.style.color = "#b42318";
            note.style.fontSize = "11px";
            note.style.overflowWrap = "anywhere";
          }
          list.append(note);
        }

        cancel.onclick = () => clearPending(null, true);
        showRoot(root, options);
      });
    }

    return {
      hide,
      showChoices,
      showLoading,
      updateLoadingStatus,
    };
  }

  return {
    create: createChooser,
  };
});
