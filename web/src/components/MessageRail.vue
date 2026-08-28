<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ShareMessage } from '../api';

const props = defineProps<{ messages: ShareMessage[] }>();

// One tick per user message, in transcript order. Assistant messages are
// not navigable — the rail is a map of the user's turns.
const userMsgs = computed(() => props.messages.filter((m) => m.role === 'user'));

const activeIdx = ref(0);
const clusterEl = ref<HTMLElement | null>(null);
const tickEls = ref<(HTMLElement | null)[]>([]);

// Fixed tick row height (px) — matches .rail-tick in style.css. Used to turn
// cluster scroll offsets into "N more" counts.
const ROW_H = 24;

// Preview = first text part (system/tool/reasoning/image excluded),
// whitespace-collapsed, truncated to 80 chars. A user message with no text
// part falls back to a generic label.
function preview(message: ShareMessage): string {
  const text = message.parts.find((p) => p.type === 'text')?.text;
  if (!text) return 'user message';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 80).trimEnd() + '…' : flat;
}

function setTickEl(el: HTMLElement | null, i: number) {
  tickEls.value[i] = el;
}

// While a click-initiated smooth scroll is in flight, the scroll/observer
// handlers would recompute the active tick to whichever message passes the
// reading line en route (or just after settling), overriding the clicked
// tick. Suppress those updates until the scroll settles.
let suppressActiveUntil = 0;
// The one-time initial-settle timeout (see onMounted). Cancelled on click so a
// slow load can't let it fire after a click and re-pin the first tick.
let settleTimer = 0;

function jumpTo(i: number) {
  const msg = userMsgs.value[i];
  if (!msg) return;
  const target = document.getElementById('msg-' + msg.seq);
  if (!target) return;
  if (settleTimer) {
    window.clearTimeout(settleTimer);
    settleTimer = 0;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  activeIdx.value = i;
  suppressActiveUntil = Date.now() + 1200;
  target.classList.remove('msg-flash');
  void target.offsetWidth; // restart the animation
  target.classList.add('msg-flash');
  target.addEventListener('animationend', () => target.classList.remove('msg-flash'), { once: true });
}

// ---- Active tracking: the user message inside the top-third band of the
// viewport is the active one. An IntersectionObserver over the user-message
// elements (a band via rootMargin) is the fast path; a scroll handler is the
// fallback (short messages can skip the band on a smooth scroll). ----
let observer: IntersectionObserver | null = null;
// The IntersectionObserver fires its initial callback synchronously for every
// element already in view when observe() is called. That batch can pick a
// transient active value before the layout settles, so callbacks arriving
// during observeTargets() are ignored; later (transition) callbacks are honored.
let inObserve = false;

function idxOf(el: Element): number {
  const seq = Number(el.id.replace('msg-', ''));
  return userMsgs.value.findIndex((m) => m.seq === seq);
}

// The active user message is the last one whose top edge is at or above the
// reading line (28% down the viewport). This is the single source of truth for
// the active tick; the IntersectionObserver is only a trigger to recompute it,
// not the decider.
function activeUserMsgIdx(): number {
  if (!userMsgs.value.length) return 0;
  const line = window.innerHeight * 0.28;
  let best = 0;
  for (let i = 0; i < userMsgs.value.length; i++) {
    const msg = userMsgs.value[i];
    if (!msg) continue;
    const el = document.getElementById('msg-' + msg.seq);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= line) best = i;
  }
  return best;
}

function observeTargets() {
  observer?.disconnect();
  if (!userMsgs.value.length) return;
  const targets = userMsgs.value
    .map((m) => document.getElementById('msg-' + m.seq))
    .filter((el): el is HTMLElement => el !== null);
  if (!targets.length) return;
  // A wide band so the observer fires whenever any message is near the
  // reading line; the callback recomputes the exact active index.
  inObserve = true;
  observer = new IntersectionObserver(
    (entries) => {
      if (inObserve) return;
      if (Date.now() < suppressActiveUntil) return;
      if (!entries.some((e) => e.isIntersecting)) return;
      const best = activeUserMsgIdx();
      if (best !== activeIdx.value) activeIdx.value = best;
    },
    { root: null, rootMargin: '-10% 0px -50% 0px', threshold: 0 },
  );
  for (const el of targets) observer.observe(el);
  // The initial callback (if any) has now fired synchronously; clear the flag
  // on the next microtask so later transition callbacks are honored.
  Promise.resolve().then(() => {
    inObserve = false;
  });
}

let scrollRaf = 0;
function onWindowScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (Date.now() < suppressActiveUntil) return;
    const best = activeUserMsgIdx();
    if (best !== activeIdx.value) activeIdx.value = best;
  });
}

let firstWatch = true;
watch(
  () => userMsgs.value.length,
  async (len) => {
    if (len === 0) return;
    if (activeIdx.value >= len) activeIdx.value = len - 1;
    await nextTick();
    // On the first run keep the initial active tick (the first user message,
    // index 0) — the layout may not have settled yet, so recomputing from
    // geometry could pick a transient value. The onMounted settle pass corrects
    // it once the page has laid out. On subsequent lazy-load pages the scroll
    // position is unchanged, so this is a no-op.
    if (!firstWatch) {
      const best = activeUserMsgIdx();
      if (best !== activeIdx.value) activeIdx.value = best;
    }
    firstWatch = false;
    observeTargets();
    updateOverflow();
  },
  { immediate: true },
);

// When the active tick changes and the cluster is internally scrolled, keep
// the active tick in view inside the cluster (only fires on active change,
// never per scroll frame).
watch(activeIdx, async (i) => {
  await nextTick();
  const tick = tickEls.value[i];
  const cluster = clusterEl.value;
  if (!tick || !cluster) return;
  if (cluster.scrollHeight <= cluster.clientHeight) return; // not scrollable
  tick.scrollIntoView({ block: 'nearest' });
});

onMounted(() => {
  window.addEventListener('scroll', onWindowScroll, { passive: true });
  // Settle the initial active tick from the actual scroll position. At the top
  // of the page the first user message is active even though it sits above the
  // observer band — anchor it explicitly so a transient geometry read can't
  // pick a later message. This anchor applies only to the initial settle, not
  // to the scroll/observer tracking (which must follow the reader). rAF can be
  // throttled under load, so also settle on a short timeout fallback.
  const settle = () => {
    const best = window.scrollY < 8 ? 0 : activeUserMsgIdx();
    if (best !== activeIdx.value) activeIdx.value = best;
  };
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = requestAnimationFrame(settle);
  });
  settleTimer = window.setTimeout(settle, 250);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  window.removeEventListener('scroll', onWindowScroll);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  if (settleTimer) window.clearTimeout(settleTimer);
});

// ---- Overflow affordance: counts of ticks hidden above/below the cluster's
// visible window. Only meaningful when the group is taller than the budget.
// Updated on the cluster's own scroll (fires only in the overflow regime).
const hiddenAbove = ref(0);
const hiddenBelow = ref(0);

function updateOverflow() {
  const c = clusterEl.value;
  if (!c) return;
  if (c.scrollHeight <= c.clientHeight) {
    hiddenAbove.value = 0;
    hiddenBelow.value = 0;
    return;
  }
  hiddenAbove.value = Math.max(0, Math.round(c.scrollTop / ROW_H));
  hiddenBelow.value = Math.max(0, Math.round((c.scrollHeight - c.scrollTop - c.clientHeight) / ROW_H));
}

function onClusterScroll() {
  updateOverflow();
}

function scrollCluster(dir: 1 | -1) {
  const c = clusterEl.value;
  if (!c) return;
  c.scrollBy({ top: dir * c.clientHeight, behavior: 'smooth' });
}

watch(
  () => userMsgs.value.length,
  async () => {
    await nextTick();
    updateOverflow();
  },
);
</script>

<template>
  <div v-if="userMsgs.length" class="rail-col" aria-label="Message navigation">
    <div
      ref="clusterEl"
      class="rail-cluster"
      :aria-label="`Jump to user message, ${userMsgs.length} total`"
      @scroll="onClusterScroll"
    >
      <button
        v-if="hiddenAbove > 0"
        type="button"
        class="rail-overflow top"
        @click="scrollCluster(-1)"
      >↑ {{ hiddenAbove }} above</button>
      <button
        v-for="(m, i) in userMsgs"
        :key="m.seq"
        :ref="(el) => setTickEl(el as HTMLElement | null, i)"
        type="button"
        class="rail-tick"
        :class="{ active: i === activeIdx }"
        :aria-label="`Jump to message ${i + 1} of ${userMsgs.length}`"
        @click="jumpTo(i)"
      >
        <span class="rail-dash" aria-hidden="true" />
        <span class="rail-tip" aria-hidden="true">
          <span class="rail-tip-n">Message {{ i + 1 }} of {{ userMsgs.length }}</span>{{ preview(m) }}
        </span>
      </button>
      <button
        v-if="hiddenBelow > 0"
        type="button"
        class="rail-overflow bottom"
        @click="scrollCluster(1)"
      >↓ {{ hiddenBelow }} below</button>
    </div>
  </div>
</template>
