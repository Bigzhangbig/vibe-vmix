'use strict';
/**
 * 编辑页共用：顶栏「显示上屏」按钮。
 * 点击后打开上屏页；窗口已存在时复用并置前，不重复弹窗。
 */
(function () {
  function openGraphics() {
    const w = window.open(
      '/graphics.html?clean=1',
      'gala-graphics',
      'width=1280,height=720,menubar=no,toolbar=no,location=no,status=no'
    );
    if (w && !w.closed) w.focus();
  }

  const list = document.querySelectorAll('[data-open-graphics]');
  for (const btn of list) {
    btn.addEventListener('click', openGraphics);
  }
})();
