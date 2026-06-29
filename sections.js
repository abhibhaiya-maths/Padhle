/* ====================================================================
   SECTIONS — interactive logic specific to individual layout concepts:
   horizontal timeline progress (About), animated counters (Results),
   and the overlapping evidence-stack carousel (Results screenshots).
   ==================================================================== */

(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', () => {
    initTimeline();
    initCounters();
    initEvidenceStack();
  });

  // ---- About: horizontal scroll-snap timeline progress + current card ----
  function initTimeline() {
    const track = document.querySelector('.timeline-track');
    if (!track) return;
    const cards = Array.from(track.querySelectorAll('.timeline-card'));
    const fill = document.querySelector('.timeline-progress-fill');
    const label = document.querySelector('.timeline-progress-label');
    const total = cards.length;

    function update() {
      const scrollLeft = track.scrollLeft;
      const maxScroll = track.scrollWidth - track.clientWidth;
      const progress = maxScroll > 0 ? scrollLeft / maxScroll : 0;
      if (fill) fill.style.width = (progress * 100) + '%';

      const trackRect = track.getBoundingClientRect();
      let closestIdx = 0;
      let closestDist = Infinity;
      cards.forEach((card, i) => {
        const r = card.getBoundingClientRect();
        const cardCenter = r.left + r.width / 2;
        const trackCenter = trackRect.left + trackRect.width / 2;
        const dist = Math.abs(cardCenter - trackCenter);
        if (dist < closestDist) { closestDist = dist; closestIdx = i; }
        card.classList.remove('is-current');
      });
      cards[closestIdx].classList.add('is-current');
      if (label) label.textContent = `${String(closestIdx + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`;
    }

    update();
    track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
    window.addEventListener('resize', update);
  }

  // ---- Results: animated big-number + ledger counters on viewport entry ----
  function initCounters() {
    const counters = document.querySelectorAll('[data-counter]');
    if (!counters.length) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function animateCounter(el) {
      const target = parseFloat(el.dataset.counter);
      const hasDecimal = target % 1 !== 0;
      const suffix = el.dataset.counterSuffix || '';
      if (reducedMotion) {
        el.textContent = (hasDecimal ? target.toFixed(1) : Math.floor(target)) + suffix;
        return;
      }
      const duration = 1600;
      const start = performance.now();
      function frame(now) {
        const elapsed = now - start;
        const t = Math.min(1, elapsed / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const val = target * eased;
        el.textContent = (hasDecimal ? val.toFixed(1) : Math.floor(val)) + suffix;
        if (t < 1) requestAnimationFrame(frame);
        else el.textContent = (hasDecimal ? target.toFixed(1) : Math.floor(target)) + suffix;
      }
      requestAnimationFrame(frame);
    }

    if (!('IntersectionObserver' in window)) {
      counters.forEach(animateCounter);
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          animateCounter(entry.target);
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.5 });
    counters.forEach(el => io.observe(el));
  }

  // ---- Results: overlapping evidence-stack carousel (drag/click/auto) ----
  function initEvidenceStack() {
    const stage = document.querySelector('.evidence-stage');
    if (!stage) return;
    const cards = Array.from(stage.querySelectorAll('.evidence-card'));
    const prevBtn = document.querySelector('.evidence-prev');
    const nextBtn = document.querySelector('.evidence-next');
    const currentLabel = document.querySelector('.evidence-progress .current');
    const totalLabel = document.querySelector('.evidence-progress .total');
    const total = cards.length;
    if (!total) return;

    let activeIndex = 0;
    let autoTimer = null;

    function render() {
      cards.forEach((card, i) => {
        let offset = (i - activeIndex + total) % total;
        card.classList.remove('depth-front', 'depth-back-1', 'depth-back-2');
        let transform = '';
        let zIndex = 0;
        let opacity = 1;

        if (offset === 0) {
          transform = 'translate(0px, 0px) rotate(0deg) scale(1)';
          zIndex = 30;
          card.classList.add('depth-front');
        } else if (offset === 1 || offset === total - 1) {
          const dir = offset === 1 ? 1 : -1;
          transform = `translate(${dir * 38}px, 16px) rotate(${dir * 4}deg) scale(0.94)`;
          zIndex = 20;
          card.classList.add('depth-back-1');
        } else if (offset === 2 || offset === total - 2) {
          const dir = offset === 2 ? 1 : -1;
          transform = `translate(${dir * 64}px, 30px) rotate(${dir * 7}deg) scale(0.88)`;
          zIndex = 10;
          card.classList.add('depth-back-2');
        } else {
          transform = 'translate(0px, 40px) scale(0.8)';
          zIndex = 0;
          opacity = 0;
        }
        card.style.transform = transform;
        card.style.zIndex = zIndex;
        card.style.opacity = opacity;
      });
      if (currentLabel) currentLabel.textContent = String(activeIndex + 1).padStart(2, '0');
      if (totalLabel) totalLabel.textContent = String(total).padStart(2, '0');
    }

    function goTo(i) {
      activeIndex = ((i % total) + total) % total;
      render();
    }
    function next() { goTo(activeIndex + 1); }
    function prev() { goTo(activeIndex - 1); }

    if (nextBtn) nextBtn.addEventListener('click', () => { next(); resetAuto(); });
    if (prevBtn) prevBtn.addEventListener('click', () => { prev(); resetAuto(); });

    cards.forEach((card, i) => {
      card.addEventListener('click', () => {
        if (i !== activeIndex) { goTo(i); resetAuto(); }
      });
    });

    let touchStartX = 0;
    stage.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
    stage.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].screenX - touchStartX;
      if (dx < -40) next();
      if (dx > 40) prev();
      resetAuto();
    }, { passive: true });

    function startAuto() {
      const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reducedMotion) return;
      autoTimer = setInterval(next, 4500);
    }
    function pauseAuto() { if (autoTimer) clearInterval(autoTimer); }
    function resetAuto() { pauseAuto(); startAuto(); }

    stage.addEventListener('mouseenter', pauseAuto);
    stage.addEventListener('mouseleave', startAuto);

    render();
    startAuto();
  }
})();
