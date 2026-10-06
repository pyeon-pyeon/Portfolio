"use strict";

(() => {
  // ============================================================
  // 설정
  // ============================================================
  const STORAGE_KEY = "card-studio-templates-v1";

  const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  const MAX_IMAGE_PIXELS = 20_000_000;
  const MAX_IMAGE_SIDE = 10_000;
  const MAX_JSON_BYTES = 20 * 1024 * 1024;
  const MAX_TEMPLATES = 20;
  const MAX_TEXT_LENGTH = 10_000;
  const MAX_DATA_URL_LENGTH = 6_000_000;

  const OUTPUT_SIZES = {
    "1:1": [1080, 1080],
    "4:5": [1080, 1350],
    "9:16": [1080, 1920],
  };

  // ============================================================
  // HTML 요소
  // ============================================================
  const $ = (id) => document.getElementById(id);

  const canvas = $("preview-canvas");
  const context = canvas.getContext("2d");

  const imageFile = $("image-file");
  const imageInfo = $("image-info");
  const removeImageButton = $("remove-image-button");

  const captionInput = $("caption-text");
  const fontSizeInput = $("font-size");
  const textColorInput = $("text-color");
  const textAlignInput = $("text-align");
  const textXInput = $("text-x");
  const textYInput = $("text-y");

  const aspectRatioInput = $("aspect-ratio");
  const imageFitInput = $("image-fit");
  const backgroundInput = $("background-color");

  const templateNameInput = $("template-name");
  const templateList = $("template-list");

  const createTemplateButton = $("create-template-button");
  const loadTemplateButton = $("load-template-button");
  const updateTemplateButton = $("update-template-button");
  const deleteTemplateButton = $("delete-template-button");

  const exportJsonButton = $("export-json-button");
  const importJsonFile = $("import-json-file");

  const statusElement = $("studio-status");
  const templateStatus = $("template-status");

  if (!context) {
    statusElement.textContent =
      "Canvas를 사용할 수 없습니다. 최신 브라우저에서 열어 주세요.";

    document.querySelectorAll("button, input, select, textarea")
      .forEach((element) => {
        element.disabled = true;
      });

    return;
  }

  // ============================================================
  // 현재 편집과 보존 템플릿
  // ============================================================
  function defaultEditor() {
    return {
      image: null,
      text: "",
      fontSize: 48,
      textColor: "#ffffff",
      textAlign: "center",
      textX: 50,
      textY: 70,
      ratio: "1:1",
      fit: "contain",
      backgroundColor: "#172743",
    };
  }

  let editor = defaultEditor();
  let loadedImage = null;
  let templates = [];
  let busy = false;
  let renderId = null;

  
  const segmenter =
    typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter("ko", { granularity: "grapheme" })
      : null;

  function characters(text) {
    if (segmenter) {
      return Array.from(
        segmenter.segment(text),
        (part) => part.segment
      );
    }

    return Array.from(text);
  }

  function announce(message) {
    statusElement.textContent = message;
  }

  function setBusy(value) {
    busy = value;

    document.querySelectorAll(
      ".editor-panel input, .editor-panel select, " +
      ".editor-panel textarea, button, " +
      "#template-name, #template-list, #import-json-file"
    ).forEach((element) => {
      element.disabled = value;
    });

    if (!value) {
      updateTemplateControls();
      removeImageButton.disabled = !editor.image;
    }
  }

  // ============================================================
  // 데이터 검증
  // ============================================================
  function isObject(value) {
    return (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    );
  }

  function isColor(value) {
    return (
      typeof value === "string" &&
      /^#[0-9a-f]{6}$/i.test(value)
    );
  }

  function isNumberInRange(value, min, max) {
    return (
      Number.isFinite(value) &&
      value >= min &&
      value <= max
    );
  }

  function validateEditor(value) {
    if (!isObject(value)) {
      throw new Error("편집 데이터가 올바르지 않습니다.");
    }

    if (
      typeof value.text !== "string" ||
      value.text.length > MAX_TEXT_LENGTH ||
      !Number.isInteger(value.fontSize) ||
      !isNumberInRange(value.fontSize, 16, 120) ||
      !isColor(value.textColor) ||
      !isColor(value.backgroundColor) ||
      !["left", "center", "right"].includes(value.textAlign) ||
      !isNumberInRange(value.textX, 10, 90) ||
      !isNumberInRange(value.textY, 5, 90) ||
      !Object.hasOwn(OUTPUT_SIZES, value.ratio) ||
      !["contain", "cover"].includes(value.fit)
    ) {
      throw new Error("편집 설정에 누락되거나 잘못된 값이 있습니다.");
    }

    if (value.image !== null) {
      if (
        !isObject(value.image) ||
        typeof value.image.dataUrl !== "string" ||
        value.image.dataUrl.length > MAX_DATA_URL_LENGTH ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(
          value.image.dataUrl
        ) ||
        !Number.isInteger(value.image.width) ||
        !Number.isInteger(value.image.height)
      ) {
        throw new Error("템플릿 이미지 데이터가 올바르지 않습니다.");
      }

      validateDimensions(
        value.image.width,
        value.image.height
      );
    }

    // 필요한 필드만 복사
    return {
      image: value.image === null
        ? null
        : {
            dataUrl: value.image.dataUrl,
            width: value.image.width,
            height: value.image.height,
          },
      text: value.text,
      fontSize: value.fontSize,
      textColor: value.textColor,
      textAlign: value.textAlign,
      textX: value.textX,
      textY: value.textY,
      ratio: value.ratio,
      fit: value.fit,
      backgroundColor: value.backgroundColor,
    };
  }

    function validateDimensions(width, height) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 1 ||
      height < 1 ||
      width > MAX_IMAGE_SIDE ||
      height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS
    ) {
      throw new Error(
        "이미지는 한 변 10,000px 이하, 총 2,000만 픽셀 이하만 가능합니다."
      );
    }
  }

  function validateTemplates(value) {
    if (
      !isObject(value) ||
      value.version !== 1 ||
      !Array.isArray(value.templates) ||
      value.templates.length > MAX_TEMPLATES
    ) {
      throw new Error("지원하는 템플릿 백업 형식이 아닙니다.");
    }

    const ids = new Set();

    return value.templates.map((item) => {
      if (
        !isObject(item) ||
        typeof item.id !== "string" ||
        item.id.length < 1 ||
        item.id.length > 100 ||
        ids.has(item.id) ||
        typeof item.name !== "string" ||
        item.name.trim().length < 1 ||
        item.name.length > 60
      ) {
        throw new Error("템플릿 이름이나 식별자가 올바르지 않습니다.");
      }

      ids.add(item.id);

      return {
        id: item.id,
        name: item.name.trim(),
        editor: validateEditor(item.editor),
      };
    });
  }

  function makeId() {
    return typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  // ============================================================
  // 이미지 검증·메타데이터 제거
  // ============================================================
  async function detectImageType(blob) {
    const bytes = new Uint8Array(
      await blob.slice(0, 12).arrayBuffer()
    );

    const pngSignature = [
      137, 80, 78, 71, 13, 10, 26, 10,
    ];

    if (
      pngSignature.every((value, index) => bytes[index] === value)
    ) {
      return "image/png";
    }

    if (
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    ) {
      return "image/jpeg";
    }

    throw new Error("실제 PNG·JPEG 파일만 불러올 수 있습니다.");
  }

  function decodeImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();

      image.onload = () => resolve(image);
      image.onerror = () => reject(
        new Error("이미지가 손상되었거나 읽을 수 없습니다.")
      );

      image.src = url;
    });
  }

  async function normalizeImage(file) {
    if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
      throw new Error("이미지는 0바이트 초과, 10MB 이하만 가능합니다.");
    }

    await detectImageType(file);

    const url = URL.createObjectURL(file);

    try {
      const image = await decodeImage(url);

      validateDimensions(
        image.naturalWidth,
        image.naturalHeight
      );

      // 원본을 다시 그려 EXIF·GPS 등 원본 메타데이터 제거.
      // 템플릿 저장 용량을 줄이기 위해 긴 변을 1920px로 제한.
      const scale = Math.min(
        1,
        1920 / Math.max(
          image.naturalWidth,
          image.naturalHeight
        )
      );

      const normalized = document.createElement("canvas");
      normalized.width = Math.max(
        1,
        Math.round(image.naturalWidth * scale)
      );
      normalized.height = Math.max(
        1,
        Math.round(image.naturalHeight * scale)
      );

      const normalizedContext = normalized.getContext("2d");

      if (!normalizedContext) {
        throw new Error("이미지를 처리할 수 없습니다.");
      }

      normalizedContext.drawImage(
        image,
        0,
        0,
        normalized.width,
        normalized.height
      );

      const dataUrl = normalized.toDataURL("image/png");

      if (dataUrl.length > MAX_DATA_URL_LENGTH) {
        throw new Error(
          "처리된 이미지가 너무 큽니다. 더 작은 이미지를 선택하세요."
        );
      }

      const cleanImage = await decodeImage(dataUrl);

      return {
        image: cleanImage,
        data: {
          dataUrl,
          width: normalized.width,
          height: normalized.height,
        },
      };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function decodeSavedImage(data) {
    if (data === null) {
      return null;
    }

    const response = await fetch(data.dataUrl);
    const blob = await response.blob();

    if (await detectImageType(blob) !== "image/png") {
      throw new Error("저장된 이미지가 PNG 형식이 아닙니다.");
    }

    const image = await decodeImage(data.dataUrl);

    validateDimensions(
      image.naturalWidth,
      image.naturalHeight
    );

    if (
      image.naturalWidth !== data.width ||
      image.naturalHeight !== data.height
    ) {
      throw new Error("저장된 이미지 크기가 데이터와 다릅니다.");
    }

    return image;
  }

  // ============================================================
  // 입력값과 화면 연결
  // ============================================================
  function syncControls() {
    captionInput.value = editor.text;
    fontSizeInput.value = String(editor.fontSize);
    textColorInput.value = editor.textColor;
    textAlignInput.value = editor.textAlign;
    textXInput.value = String(editor.textX);
    textYInput.value = String(editor.textY);
    aspectRatioInput.value = editor.ratio;
    imageFitInput.value = editor.fit;
    backgroundInput.value = editor.backgroundColor;

    removeImageButton.disabled = busy || !editor.image;

    imageInfo.textContent = editor.image
      ? `처리된 이미지: ${editor.image.width} × ${editor.image.height}px`
      : "선택한 이미지가 없습니다.";
  }

  function readControls() {
    editor.text = captionInput.value;
    editor.fontSize = Number(fontSizeInput.value);
    editor.textColor = textColorInput.value;
    editor.textAlign = textAlignInput.value;
    editor.textX = Number(textXInput.value);
    editor.textY = Number(textYInput.value);
    editor.ratio = aspectRatioInput.value;
    editor.fit = imageFitInput.value;
    editor.backgroundColor = backgroundInput.value;
  }

  function scheduleRender() {
    if (renderId !== null) {
      cancelAnimationFrame(renderId);
    }

    renderId = requestAnimationFrame(() => {
      renderId = null;
      render();
    });
  }

  // ============================================================
  // 이미지와 문구 그리기
  // ============================================================
  function wrapText(text, maximumWidth) {
    const lines = [];
    const paragraphs = text
      .replace(/\r\n?/g, "\n")
      .split("\n");

    for (const paragraph of paragraphs) {
      let line = "";

      for (const character of characters(paragraph)) {
        const candidate = line + character;

        if (
          line !== "" &&
          context.measureText(candidate).width > maximumWidth
        ) {
          lines.push(line);
          line = character;
        } else {
          line = candidate;
        }
      }

      lines.push(line);
    }

    return lines;
  }

  function render() {
    const [width, height] = OUTPUT_SIZES[editor.ratio];

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.clearRect(0, 0, width, height);
    context.fillStyle = editor.backgroundColor;
    context.fillRect(0, 0, width, height);

    if (loadedImage) {
      const scale = editor.fit === "cover"
        ? Math.max(
            width / loadedImage.naturalWidth,
            height / loadedImage.naturalHeight
          )
        : Math.min(
            width / loadedImage.naturalWidth,
            height / loadedImage.naturalHeight
          );

      const imageWidth = loadedImage.naturalWidth * scale;
      const imageHeight = loadedImage.naturalHeight * scale;

      context.drawImage(
        loadedImage,
        (width - imageWidth) / 2,
        (height - imageHeight) / 2,
        imageWidth,
        imageHeight
      );
    }

    context.font =
      `bold ${editor.fontSize}px "Malgun Gothic", ` +
      `"Noto Sans KR", Arial, sans-serif`;
    context.textBaseline = "top";
    context.textAlign = editor.textAlign;
    context.fillStyle = editor.textColor;
    context.strokeStyle = "#000000";
    context.lineWidth = Math.max(2, editor.fontSize / 18);
    context.lineJoin = "round";

    const padding = 32;
    const centerX = width * editor.textX / 100;

    // 위치를 바꿔도 문구 영역이 좌우 경계를 넘지 않도록 설정
    const halfWidth = Math.max(
      1,
      Math.min(
        centerX - padding,
        width - padding - centerX
      )
    );

    const maximumWidth = halfWidth * 2;
    const lines = wrapText(editor.text, maximumWidth);
    const lineHeight = editor.fontSize * 1.35;

    const textHeight = lines.length * lineHeight;
    const wantedY = height * editor.textY / 100;

    const startY = Math.max(
      padding,
      Math.min(wantedY, height - padding - textHeight)
    );

    const anchorX = editor.textAlign === "left"
      ? centerX - halfWidth
      : editor.textAlign === "right"
        ? centerX + halfWidth
        : centerX;

    // 넘치는 문구는 안전 영역에서 잘라 표시.
    // 입력한 원문은 그대로 유지.
    context.save();
    context.beginPath();
    context.rect(
      padding,
      padding,
      width - padding * 2,
      height - padding * 2
    );
    context.clip();

    lines.forEach((line, index) => {
      const y = startY + index * lineHeight;

      if (y < height - padding) {
        context.strokeText(line, anchorX, y, maximumWidth);
        context.fillText(line, anchorX, y, maximumWidth);
      }
    });

    context.restore();

    $("font-size-value").textContent = `${editor.fontSize}px`;
    $("text-x-value").textContent = `${editor.textX}%`;
    $("text-y-value").textContent = `${editor.textY}%`;
    $("output-size").textContent = `${width} × ${height}px`;

    const overflow = (
      editor.text !== "" &&
      startY + textHeight > height - padding
    );

    $("preview-description").textContent =
      `${editor.ratio} 카드, ` +
      `${loadedImage ? "이미지 있음" : "배경색만 표시"}, ` +
      `문구 ${editor.text.length}자.` +
      (overflow
        ? " 문구가 출력 영역을 넘습니다. 글자 크기를 줄이거나 내용을 줄여 주세요."
        : "");

    canvas.setAttribute(
      "aria-label",
      editor.text
        ? `카드 미리보기: ${editor.text.slice(0, 150)}`
        : "문구가 없는 카드 미리보기"
    );
  }

  // ============================================================
  // 템플릿 저장
  // 저장 실패 시 기존 목록을 변경하지 않음
  // ============================================================
  function persistTemplates(nextTemplates) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          templates: nextTemplates,
        })
      );
    } catch {
      throw new Error(
        "저장 공간이 부족하거나 저장이 차단되었습니다. " +
        "기존 템플릿은 유지됩니다. 이미지를 줄여 다시 시도하세요."
      );
    }

    templates = nextTemplates;
  }

  function selectedTemplate() {
    return templates.find(
      (item) => item.id === templateList.value
    );
  }

  function updateTemplateControls() {
    const selected = Boolean(selectedTemplate());

    templateList.disabled = busy || templates.length === 0;
    loadTemplateButton.disabled = busy || !selected;
    updateTemplateButton.disabled = busy || !selected;
    deleteTemplateButton.disabled = busy || !selected;
    exportJsonButton.disabled = busy || templates.length === 0;
  }

  function renderTemplateList(selectedId = "") {
    templateList.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = templates.length
      ? "템플릿을 선택하세요."
      : "저장한 템플릿이 없습니다.";

    templateList.append(placeholder);

    templates.forEach((item) => {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      templateList.append(option);
    });

    templateList.value = selectedId;

    templateStatus.textContent =
      `저장한 템플릿 ${templates.length}개`;

    updateTemplateControls();
  }

  function getTemplateName() {
    const name = templateNameInput.value.trim();

    if (!name || name.length > 60) {
      throw new Error("템플릿 이름을 1~60자로 입력하세요.");
    }

    return name;
  }

  async function loadStoredTemplates() {
    let raw;

    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      announce(
        "브라우저 저장소에 접근할 수 없습니다. 편집과 다운로드는 가능합니다."
      );
      return;
    }

    if (raw === null) {
      return;
    }

    try {
      const parsed = validateTemplates(JSON.parse(raw));

      // 모든 이미지가 정상인지 확인한 뒤 목록 반영
      for (const item of parsed) {
        await decodeSavedImage(item.editor.image);
      }

      templates = parsed;
    } catch {
      templates = [];

      announce(
        "저장된 템플릿을 읽을 수 없어 빈 목록으로 시작합니다. " +
        "원래 저장값은 자동 삭제하지 않았습니다."
      );
    }
  }

  // ============================================================
  // 파일 다운로드
  // ============================================================
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  // ============================================================
  // 편집 이벤트
  // ============================================================
  captionInput.maxLength = MAX_TEXT_LENGTH;

  [
    captionInput,
    fontSizeInput,
    textColorInput,
    textAlignInput,
    textXInput,
    textYInput,
    aspectRatioInput,
    imageFitInput,
    backgroundInput,
  ].forEach((element) => {
    element.addEventListener("input", () => {
      readControls();
      scheduleRender();
    });
  });

  imageFile.addEventListener("change", async () => {
    const file = imageFile.files[0];

    if (!file || busy) {
      return;
    }

    setBusy(true);

    try {
      const normalized = await normalizeImage(file);

      // 성공한 뒤에만 기존 이미지 교체
      editor.image = normalized.data;
      loadedImage = normalized.image;

      syncControls();
      render();

      announce(
        "이미지를 불러왔습니다. 원본 메타데이터를 제외하고 " +
        "긴 변 최대 1920px로 처리했습니다."
      );
    } catch (error) {
      announce(error.message);
    } finally {
      imageFile.value = "";
      setBusy(false);
    }
  });

  removeImageButton.addEventListener("click", () => {
    editor.image = null;
    loadedImage = null;

    syncControls();
    render();
    announce("이미지를 제거했습니다. 문구와 설정은 유지합니다.");
  });

  $("reset-editor-button").addEventListener("click", () => {
    editor = defaultEditor();
    loadedImage = null;
    imageFile.value = "";

    syncControls();
    render();

    announce("편집 내용을 초기화했습니다. 템플릿은 유지합니다.");
  });

  $("download-png-button").addEventListener("click", () => {
    // 예약된 미리보기 갱신을 기다리지 않고 최신 값으로 출력
    readControls();
    render();

    canvas.toBlob((blob) => {
      if (!blob) {
        announce("PNG 파일을 생성하지 못했습니다.");
        return;
      }

      downloadBlob(
        blob,
        `card-${editor.ratio.replace(":", "x")}.png`
      );

      announce("현재 미리보기의 PNG 다운로드를 요청했습니다.");
    }, "image/png");
  });

  // ============================================================
  // 템플릿 CRUD
  // ============================================================
  templateList.addEventListener("change", () => {
    updateTemplateControls();
  });

  createTemplateButton.addEventListener("click", () => {
    try {
      if (templates.length >= MAX_TEMPLATES) {
        throw new Error("템플릿은 최대 20개까지 저장할 수 있습니다.");
      }

      readControls();

      const item = {
        id: makeId(),
        name: getTemplateName(),
        editor: validateEditor(clone(editor)),
      };

      persistTemplates([...templates, item]);
      renderTemplateList(item.id);

      announce("새 템플릿을 저장했습니다.");
    } catch (error) {
      announce(error.message);
    }
  });

  loadTemplateButton.addEventListener("click", async () => {
    const item = selectedTemplate();

    if (!item || busy) {
      return;
    }

    setBusy(true);

    try {
      const nextEditor = validateEditor(clone(item.editor));
      const nextImage = await decodeSavedImage(nextEditor.image);

      editor = nextEditor;
      loadedImage = nextImage;
      templateNameInput.value = item.name;

      syncControls();
      render();

      announce("템플릿을 불러왔습니다.");
    } catch (error) {
      announce(error.message);
    } finally {
      setBusy(false);
    }
  });

  updateTemplateButton.addEventListener("click", () => {
    try {
      const selected = selectedTemplate();

      if (!selected) {
        return;
      }

      readControls();

      const replacement = {
        id: selected.id,
        name: getTemplateName(),
        editor: validateEditor(clone(editor)),
      };

      const next = templates.map((item) =>
        item.id === selected.id ? replacement : item
      );

      persistTemplates(next);
      renderTemplateList(selected.id);

      announce("선택한 템플릿을 수정했습니다.");
    } catch (error) {
      announce(error.message);
    }
  });

  deleteTemplateButton.addEventListener("click", () => {
    try {
      const selected = selectedTemplate();

      if (!selected) {
        return;
      }

      persistTemplates(
        templates.filter((item) => item.id !== selected.id)
      );

      renderTemplateList();

      announce(
        "선택한 템플릿을 삭제했습니다. 현재 편집 내용은 유지합니다."
      );
    } catch (error) {
      announce(error.message);
    }
  });

  // ============================================================
  // JSON 백업·복원
  // ============================================================
  exportJsonButton.addEventListener("click", () => {
    const json = JSON.stringify(
      { version: 1, templates },
      null,
      2
    );

    const blob = new Blob(
      [json],
      { type: "application/json" }
    );

    if (blob.size > MAX_JSON_BYTES) {
      announce(
        "백업이 20MB를 넘습니다. 템플릿 수나 이미지 크기를 줄여 주세요."
      );
      return;
    }

    downloadBlob(blob, "card-studio-templates.json");
    announce("템플릿 JSON 다운로드를 요청했습니다.");
  });

  importJsonFile.addEventListener("change", async () => {
    const file = importJsonFile.files[0];

    if (!file || busy) {
      return;
    }

    setBusy(true);

    try {
      if (
        file.size === 0 ||
        file.size > MAX_JSON_BYTES
      ) {
        throw new Error("JSON 파일은 0바이트 초과, 20MB 이하만 가능합니다.");
      }

      let parsed;

      try {
        parsed = JSON.parse(await file.text());
      } catch {
        throw new Error("JSON 문법이 올바르지 않습니다.");
      }

      const imported = validateTemplates(parsed);

      if (templates.length + imported.length > MAX_TEMPLATES) {
        throw new Error(
          "복원 후 템플릿이 20개를 넘습니다. 기존 목록은 유지됩니다."
        );
      }

      // 전부 검증 완료 후 한 번에 저장
      const cleanTemplates = [];

      for (const item of imported) {
        const nextEditor = clone(item.editor);

        if (nextEditor.image) {
          const image = await decodeSavedImage(nextEditor.image);

          // JSON에 들어온 이미지도 다시 그려 메타데이터 제거
          const cleanCanvas = document.createElement("canvas");
          cleanCanvas.width = image.naturalWidth;
          cleanCanvas.height = image.naturalHeight;

          const cleanContext = cleanCanvas.getContext("2d");

          if (!cleanContext) {
            throw new Error("복원 이미지를 처리할 수 없습니다.");
          }

          cleanContext.drawImage(image, 0, 0);

          nextEditor.image.dataUrl =
            cleanCanvas.toDataURL("image/png");

          if (
            nextEditor.image.dataUrl.length >
            MAX_DATA_URL_LENGTH
          ) {
            throw new Error("복원 이미지가 너무 큽니다.");
          }
        }

        cleanTemplates.push({
          id: makeId(),
          name: item.name,
          editor: validateEditor(nextEditor),
        });
      }

      if (cleanTemplates.length === 0) {
        announce("백업에 복원할 템플릿이 없습니다.");
        return;
      }

      persistTemplates([...templates, ...cleanTemplates]);
      renderTemplateList();

      announce(
        `${cleanTemplates.length}개 템플릿을 추가했습니다. ` +
        "현재 편집 내용은 유지합니다."
      );
    } catch (error) {
      announce(error.message);
    } finally {
      importJsonFile.value = "";
      setBusy(false);
    }
  });

  // ============================================================
  // 최초 실행
  // ============================================================
  async function initialize() {
    setBusy(true);

    syncControls();
    render();

    await loadStoredTemplates();

    renderTemplateList();
    setBusy(false);
  }

  initialize().catch(() => {
    setBusy(false);
    announce("초기화 중 문제가 발생했습니다. 새로고침해 주세요.");
  });
})();