<script lang="ts">
  let { size = 30 }: { size?: number } = $props();
  const id = `tt-grad-${Math.random().toString(36).slice(2, 8)}`;
</script>

<svg class="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
  <defs>
    <linearGradient {id} x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ff8a4c" />
      <stop offset="1" stop-color="#ff3d6e" />
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="8.5" fill="url(#{id})" />
  <path d="M18.2 4.8 8.6 18h6.2l-2.1 9.2L23.4 13.4h-6.3l1.1-8.6Z" fill="#fff" />
</svg>
