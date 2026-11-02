// 调一次 exportManifest，等系统保存对话框弹出后由外部脚本发 Esc 取消，
// 用返回值的 skipped 验证主进程侧的过滤口径（本地路径来源应被跳过）
(async () => {
  const res = await window.dsh.exportManifest('desktop');
  return { res };
})();
