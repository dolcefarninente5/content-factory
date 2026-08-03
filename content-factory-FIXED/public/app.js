async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 401) {
    window.location.href = '/login.html';
    return null;
  }
  if (!res.ok) {
    console.error('API error', path, res.status);
    return null;
  }
  return res.json();
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
}
