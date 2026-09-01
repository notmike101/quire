<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { messageAnchorId, type MessageIdentity, type ShareMessage, type RailUserEntry } from '../api';

const props = defineProps<{
  // Full-share user-message index (identity + preview) — one tick per entry, all
  // present from the first page even though the messages lazy-load.
  userIndex: RailUserEntry[];
  // The messages loaded so far (used to know which ticks are jumpable and to
  // locate the active one).
  messages: ShareMessage[];
  // Load pages up to (and including) the message with this identity. Called when a
  // tick whose message hasn't loaded yet is clicked.
  ensureLoadedThrough: (target: MessageIdentity) => Promise<void>;
}>();

// One tick per user message in the full-share index, in transcript order.
// Assistant messages are not navigable — the rail is a map of the user's turns.
const entries = computed(() => props.userIndex);

// The identities of user messages that have loaded into the DOM.
// anchor). Active tracking and the IntersectionObserver only consider these —
// a tick whose message isn't loaded yet can't be "the one on screen".
const loadedIds = computed(() =>
  props.messages.filter((m) => m.role === 'user').map(messageAnchorId),
);

const activeIdx = ref(0);
const clusterEl = ref<HTMLElement | null>(null);
const tickEls = ref<(HTMLElement | null)[]>([]);

// Fixed tick row height (px) — matches .rail-tick in style.css. Used to turn
// cluster scroll offsets into "N more" counts.
const ROW_H = 12;

function preview(entry: RailUserEntry): string {
  return entry.preview || 'user message';
}

function setTickEl(el: HTMLElement | null, i: number) {
  tickEls.value[i] = el;
}

// ---- Hover tooltip. The tooltip is rendered `position: fixed` and positioned
// from the hovered tick's rect. An in-flow/absolute tooltip centered on a 24px
// tick overflows ~32px below it; because the tick is `overflow: visible`, that
// overflow leaks into the cluster's scrollHeight and makes a short rail look
// (and measure) overflowing — turning the scrollbar on spuriously. `fixed`
// takes the tooltip out of the document flow entirely, so it can never inflate
// any ancestor's scroll size. It is pointer-only (hidden on touch via CSS). ----
const tipEl = ref<HTMLElement | null>(null);
const tipVisible = ref(false);
const tipIdx = ref(0);
const tipPreview = computed(() => {
  const entry = entries.value[tipIdx.value];
  return entry ? preview(entry) : '';
});

function showTip(i: number) {
  const tick = tickEls.value[i];
  if (!tick) return;
  tipIdx.value = i;
  tipVisible.value = true;
  // The tooltip is v-if'd, so it doesn't exist in the DOM yet. A single
  // nextTick can resolve before Vue's patch has inserted it, leaving
  // tipEl.value null and skipping the positioning. Poll briefly until the
  // element exists, then position it from the tick's current rect.
  void (async () => {
    for (let n = 0; n < 20; n++) {
      await nextTick();
      const tip = tipEl.value;
      if (tip) {
        const r = tick.getBoundingClientRect();
        // To the right of the tick, vertically centered on it. Flip to the
        // left if there isn't room on the right (narrow viewports).
        const width = 230;
        const left = r.right + 10;
        tip.style.left = left + width > window.innerWidth ? `${r.left - width - 10}px` : `${left}px`;
        tip.style.top = `${r.top + r.height / 2}px`; // CSS translateY(-50%) centers it
        return;
      }
      await new Promise((r) => setTimeout(r, 8));
    }
  })();
}

function hideTip() {
  tipVisible.value = false;
}

// While a click-initiated smooth scroll is in flight, the scroll/observer
// handlers would recompute the active tick to whichever message passes the
// reading line en route (or just after settling), overriding the clicked
// tick. Suppress those updates until the scroll settles.
let suppressActiveUntil = 0;
// The one-time initial-settle timeout (see onMounted). Cancelled on click so a
// slow load can't let it fire after a click and re-pin the first tick.
let settleTimer = 0;
let settleRaf = 0;
let settleRaf2 = 0;

async function jumpTo(i: number) {
  const entry = entries.value[i];
  if (!entry) return;
  // If the message for this tick hasn't loaded yet, load the pages up to it
  // first so the anchor exists.
  const id = messageAnchorId(entry);
  if (!loadedIds.value.includes(id)) {
    await props.ensureLoadedThrough({ chunkSeq: entry.chunkSeq, seq: entry.seq });
    // The anchor is added by Vue's patch of the newly loaded messages. A single
    // nextTick can resolve before that patch has landed (especially with many
    // heavy markdown/code messages), so poll briefly until the element exists.
    for (let n = 0; n < 50; n++) {
      await nextTick();
      if (document.getElementById(id)) break;
      await new Promise((r) => setTimeout(r, 16));
    }
  }
  const target = document.getElementById(id);
  if (!target) return;
  if (settleTimer) {
    window.clearTimeout(settleTimer);
    settleTimer = 0;
  }
  if (settleRaf) {
    cancelAnimationFrame(settleRaf);
    settleRaf = 0;
  }
  if (settleRaf2) {
    cancelAnimationFrame(settleRaf2);
    settleRaf2 = 0;
  }
  // The destination of a smooth scroll is computed once; if the document height
  // still shifts (e.g. lazy-loaded messages finishing layout) the scroll can land
  // short of the target. Scroll, then verify the target reached the top and
  // re-scroll once if it didn't.
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  activeIdx.value = i;
  suppressActiveUntil = Date.now() + 1200;
  target.classList.remove('msg-flash');
  void target.offsetWidth; // restart the animation
  target.classList.add('msg-flash');
  target.addEventListener('animationend', () => target.classList.remove('msg-flash'), { once: true });
  // Re-target after the smooth scroll settles, in case the document shifted.
  window.setTimeout(() => {
    if (Date.now() < suppressActiveUntil) {
      const t = document.getElementById(id);
      if (t && t.getBoundingClientRect().top > 40) {
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, 450);
}

// ---- Active tracking: the user message inside the top-third band of the
// viewport is the active one. An IntersectionObserver over the loaded
// user-message elements (a band via rootMargin) is the fast path; a scroll
// handler is the fallback (short messages can skip the band on a smooth
// scroll). Only loaded messages count — a tick whose message isn't in the DOM
// yet can't be the active one. ----
let observer: IntersectionObserver | null = null;
// The IntersectionObserver fires its initial callback synchronously for every
// element already in view when observe() is called. That batch can pick a
// transient active value before the layout settles, so callbacks arriving
// during observeTargets() are ignored; later (transition) callbacks are honored.
let inObserve = false;

// The active user message is the last LOADED one whose top edge is at or above
// the reading line (28% down the viewport). This is the single source of truth
// for the active tick; the IntersectionObserver is only a trigger to recompute
// it, not the decider.
function activeUserMsgIdx(): number {
  if (!loadedIds.value.length) return 0;
  const line = window.innerHeight * 0.28;
  let best = 0;
  for (let i = 0; i < loadedIds.value.length; i++) {
    const id = loadedIds.value[i];
    if (id === undefined) continue;
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.getBoundingClientRect().top <= line) best = i;
  }
  return best;
}

function observeTargets() {
  observer?.disconnect();
  if (!loadedIds.value.length) return;
  const targets = loadedIds.value
    .map((id) => document.getElementById(id))
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

// Re-observe whenever the set of loaded messages changes (first page, and each
// lazy-load page). The tick list itself is stable (driven by userIndex), so the
// immediate watch only needs to run once for the observer + overflow.
let firstWatch = true;
watch(
  () => loadedIds.value.length,
  async (len) => {
    if (len === 0) return;
    // Keep the active index valid if the loaded set ever shrinks (it doesn't in
    // practice, but guard against an out-of-range index).
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
    scheduleOverflowSettle();
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
  window.addEventListener('resize', onResize);
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
  settleRaf = requestAnimationFrame(() => {
    settleRaf = 0;
    settleRaf2 = requestAnimationFrame(() => {
      settleRaf2 = 0;
      settle();
    });
  });
  settleTimer = window.setTimeout(settle, 250);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
  window.removeEventListener('scroll', onWindowScroll);
  window.removeEventListener('resize', onResize);
  if (scrollRaf) cancelAnimationFrame(scrollRaf);
  if (settleRaf) cancelAnimationFrame(settleRaf);
  if (settleRaf2) cancelAnimationFrame(settleRaf2);
  if (settleTimer) window.clearTimeout(settleTimer);
});

// ---- Overflow: toggle the .is-overflowing class so the scrollbar only
// appears when the tick group actually exceeds the viewport budget.
// Re-evaluated after layout settles and on resize.
function updateOverflow() {
  const c = clusterEl.value;
  if (!c) return;
  c.classList.toggle('is-overflowing', c.scrollHeight > c.clientHeight);
}

let overflowSettle = 0;
function scheduleOverflowSettle() {
  if (overflowSettle) window.clearTimeout(overflowSettle);
  overflowSettle = window.setTimeout(updateOverflow, 300);
}

watch(
  () => entries.value.length,
  async () => {
    await nextTick();
    updateOverflow();
    scheduleOverflowSettle();
  },
);

function onResize() {
  updateOverflow();
}
</script>

<template>
  <div v-if="entries.length" class="rail-col" aria-label="Message navigation">
    <div
      ref="clusterEl"
      class="rail-cluster"
      :aria-label="`Jump to user message, ${entries.length} total`"
    >
      <button
        v-for="(entry, i) in entries"
        :key="messageAnchorId(entry)"
        :ref="(el) => setTickEl(el as HTMLElement | null, i)"
        type="button"
        class="rail-tick"
        :class="{ active: i === activeIdx }"
        :aria-label="`Jump to message ${i + 1} of ${entries.length}`"
        @click="jumpTo(i)"
        @mouseenter="showTip(i)"
        @mouseleave="hideTip"
        @focus="showTip(i)"
        @blur="hideTip"
      >
        <span class="rail-dash" aria-hidden="true" />
      </button>
    </div>
    <div
      v-if="tipVisible"
      ref="tipEl"
      class="rail-tip"
      role="tooltip"
      aria-hidden="true"
    >
      <span class="rail-tip-n">Message {{ tipIdx + 1 }} of {{ entries.length }}</span>{{ tipPreview }}
    </div>
  </div>
</template>
