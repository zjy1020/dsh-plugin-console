(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  location.reload();
  return "reloading";
})();
