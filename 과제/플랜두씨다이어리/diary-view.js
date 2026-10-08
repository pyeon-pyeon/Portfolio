"use strict";

(() => {
  const VIEW_TITLES = Object.freeze({
    summary: "summary-title",
    plan: "plan-title",
    do: "do-title",
    see: "see-title",
  });

  const buttons = Array.from(
    document.querySelectorAll("[data-diary-view]")
  );

  const screens = Array.from(
    document.querySelectorAll("[data-diary-screen]")
  );

  let currentView = "summary";

  function isValidView(view) {
    return Object.prototype.hasOwnProperty.call(VIEW_TITLES, view);
  }

  function show(view, moveFocus = true) {
    if (!isValidView(view)) return false;

    const selectedScreen = screens.find(
      (screen) => screen.dataset.diaryScreen === view
    );

    if (!selectedScreen) return false;

    currentView = view;

    // 선택한 화면만 표시합니다.
    screens.forEach((screen) => {
      screen.hidden = screen !== selectedScreen;
    });

    // 현재 선택한 메뉴를 표시합니다.
    buttons.forEach((button) => {
      const selected = button.dataset.diaryView === view;

      button.setAttribute("aria-pressed", String(selected));
      button.classList.toggle("is-active", selected);
    });

    if (moveFocus) {
      const title = document.getElementById(VIEW_TITLES[view]);

      if (title) {
        title.setAttribute("tabindex", "-1");
        title.focus();
      }
    }

    return true;
  }

  function focusNode(id) {
    const node = document.getElementById(id);

    if (!node) return false;

    const screen = node.closest("[data-diary-screen]");

    if (screen && !show(screen.dataset.diaryScreen, false)) {
      return false;
    }

    // 입력 요소와 버튼 이외의 요소도 초점을 받을 수 있게 합니다.
    if (
      !node.matches(
        "button, input, select, textarea, a[href], [tabindex]"
      )
    ) {
      node.setAttribute("tabindex", "-1");
    }

    node.focus();

    return document.activeElement === node;
  }

  buttons.forEach((button) => {
    button.addEventListener("click", () => {
      show(button.dataset.diaryView);
    });
  });

  // 다른 파일에서도 화면을 전환할 수 있도록 공개합니다.
  window.PdsView = Object.freeze({
    show,
    focusNode,

    current() {
      return currentView;
    },
  });

  // 첫 화면은 요약으로 시작합니다.
  show("summary", false);
})();