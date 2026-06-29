/* ====================================================================
   MOTION CONTROLLER
   Handles every generic, reusable interaction primitive: scroll
   reveals, magnetic buttons, card tilt, spotlight cursor, nav scroll
   state, mobile menu, and the signature "thread rail" scroll progress.
   Section-specific logic (carousel, timeline drag, orbit) lives in
   their own files. Everything here guards for prefers-reduced-motion
   and for missing elements, so partial markup never throws.
   ==================================================================== */

(function () {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.addEventListener('DOMContentLoaded', () => {
    initNavScroll();
    initMobileMenu();
    initScrollReveal();
    if (!reducedMotion) {
      initMagneticButtons();
      initTiltCards();
      initSpotlight();
    }
    initThreadRail();
  });

  // ---- Nav: shrink + opaque on scroll ----
  function initNavScroll() {
    const capsule = document.querySelector('.nav-capsule');
    if (!capsule) return;
    const onScroll = () => {
      capsule.classList.toggle('is-scrolled', window.scrollY > 24);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---- Mobile full-screen menu ----
  function initMobileMenu() {
    const menu = document.getElementById('mobile-menu');
    const openBtn = document.getElementById('mobile-menu-btn');
    const closeBtn = document.getElementById('mobile-menu-close');
    if (!menu || !openBtn) return;

    const open = () => { menu.classList.add('is-open'); document.body.style.overflow = 'hidden'; };
    const close = () => { menu.classList.remove('is-open'); document.body.style.overflow = ''; };

    openBtn.addEventListener('click', open);
    if (closeBtn) closeBtn.addEventListener('click', close);
    menu.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
  }

  // ---- Scroll reveal via IntersectionObserver ----
  function initScrollReveal() {
    const targets = document.querySelectorAll('.reveal');
    if (!targets.length) return;

    if (!('IntersectionObserver' in window) || reducedMotion) {
      targets.forEach(el => el.classList.add('is-visible'));
      return;
    }

    const io = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          // stagger children of the same parent slightly using a data attr
          const delay = entry.target.dataset.revealDelay || 0;
          setTimeout(() => entry.target.classList.add('is-visible'), Number(delay));
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

    targets.forEach(el => io.observe(el));
  }

  // ---- Magnetic buttons: pull toward cursor within a small radius ----
  function initMagneticButtons() {
    const items = document.querySelectorAll('.btn-magnetic');
    items.forEach(el => {
      const strength = 0.35;
      const reset = () => { el.style.setProperty('--mx', '0px'); el.style.setProperty('--my', '0px'); };
      el.addEventListener('mousemove', (e) => {
        const rect = el.getBoundingClientRect();
        const mx = (e.clientX - rect.left - rect.width / 2) * strength;
        const my = (e.clientY - rect.top - rect.height / 2) * strength;
        el.style.setProperty('--mx', mx.toFixed(1) + 'px');
        el.style.setProperty('--my', my.toFixed(1) + 'px');
      });
      el.addEventListener('mouseleave', reset);
    });
  }

  // ---- Card tilt on mousemove ----
  function initTiltCards() {
    const items = document.querySelectorAll('.tilt');
    items.forEach(el => {
      const max = 6; // degrees
      el.addEventListener('mousemove', (e) => {
        const rect = el.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width;  // 0..1
        const py = (e.clientY - rect.top) / rect.height;
        const ry = (px - 0.5) * max * 2;
        const rx = (0.5 - py) * max * 2;
        el.style.setProperty('--rx', rx.toFixed(2) + 'deg');
        el.style.setProperty('--ry', ry.toFixed(2) + 'deg');
      });
      el.addEventListener('mouseleave', () => {
        el.style.setProperty('--rx', '0deg');
        el.style.setProperty('--ry', '0deg');
      });
    });
  }

  // ---- Spotlight cursor inside [data-spotlight] sections ----
  function initSpotlight() {
    const sections = document.querySelectorAll('[data-spotlight]');
    sections.forEach(sec => {
      sec.addEventListener('mousemove', (e) => {
        const rect = sec.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width) * 100;
        const y = ((e.clientY - rect.top) / rect.height) * 100;
        sec.style.setProperty('--spot-x', x + '%');
        sec.style.setProperty('--spot-y', y + '%');
        sec.classList.add('spotlight-active');
      });
      sec.addEventListener('mouseleave', () => sec.classList.remove('spotlight-active'));
    });
  }

  // ---- Thread rail: fills with overall scroll progress, lights up
  //      the node nearest the section currently centred in viewport ----
  function initThreadRail() {
    const rail = document.getElementById('thread-rail');
    if (!rail) return;
    const fill = rail.querySelector('.thread-fill');
    const nodes = Array.from(rail.querySelectorAll('.thread-node'));
    const sectionIds = nodes.map(n => n.dataset.target).filter(Boolean);
    const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);

    function update() {
      const scrollTop = window.scrollY;
      const docHeight = document.documentElement.scrollHeight - window.innerHeight;
      const progress = docHeight > 0 ? Math.min(1, Math.max(0, scrollTop / docHeight)) : 0;
      if (fill) fill.style.height = (progress * 100) + '%';

      let activeIdx = 0;
      const viewportCenter = scrollTop + window.innerHeight * 0.4;
      sections.forEach((sec, i) => {
        if (sec.offsetTop <= viewportCenter) activeIdx = i;
      });
      nodes.forEach((n, i) => n.classList.toggle('active', i === activeIdx));
    }

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }
})();
