// Student avatars, shared by the server (to validate) and the browser pages (to draw).
// Each avatar is an emoji on a coloured circle, so nothing is loaded from outside.
(function (root) {
  const AVATARS = [
    { id: 'fox', emoji: '🦊', name: 'Fox', color: '#f97316' },
    { id: 'panda', emoji: '🐼', name: 'Panda', color: '#64748b' },
    { id: 'rocket', emoji: '🚀', name: 'Rocket', color: '#6366f1' },
    { id: 'lion', emoji: '🦁', name: 'Lion', color: '#eab308' },
    { id: 'alien', emoji: '👾', name: 'Alien', color: '#a855f7' },
    { id: 'flash', emoji: '⚡', name: 'Flash', color: '#f59e0b' },
    { id: 'octopus', emoji: '🐙', name: 'Octopus', color: '#ec4899' },
    { id: 'unicorn', emoji: '🦄', name: 'Unicorn', color: '#d946ef' },
    { id: 'frog', emoji: '🐸', name: 'Frog', color: '#22c55e' },
    { id: 'tiger', emoji: '🐯', name: 'Tiger', color: '#ea580c' },
    { id: 'koala', emoji: '🐨', name: 'Koala', color: '#94a3b8' },
    { id: 'owl', emoji: '🦉', name: 'Owl', color: '#a16207' },
    { id: 'whale', emoji: '🐳', name: 'Whale', color: '#0ea5e9' },
    { id: 'dino', emoji: '🦖', name: 'Dino', color: '#16a34a' },
    { id: 'penguin', emoji: '🐧', name: 'Penguin', color: '#0f766e' },
    { id: 'robot', emoji: '🤖', name: 'Robot', color: '#3b82f6' },
    { id: 'ghost', emoji: '👻', name: 'Ghost', color: '#7c3aed' },
    { id: 'pizza', emoji: '🍕', name: 'Pizza', color: '#dc2626' },
    { id: 'cactus', emoji: '🌵', name: 'Cactus', color: '#15803d' },
    { id: 'star', emoji: '🌟', name: 'Star', color: '#ca8a04' },
  ];
  const byId = Object.fromEntries(AVATARS.map((a) => [a.id, a]));
  const api = {
    list: AVATARS,
    get: (id) => byId[id] || null,
    isValid: (id) => Object.prototype.hasOwnProperty.call(byId, id),
    random: (exceptId) => {
      const pool = AVATARS.filter((a) => a.id !== exceptId);
      return pool[Math.floor(Math.random() * pool.length)];
    },
    // Small HTML badge for lists; `size` in px.
    badge: (id, size = 32) => {
      const a = byId[id];
      if (!a) return '';
      return `<span class="avatar" style="--av:${a.color};width:${size}px;height:${size}px;font-size:${Math.round(size * 0.58)}px" title="${a.name}" aria-label="${a.name}">${a.emoji}</span>`;
    },
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Avatars = api;
})(this);
