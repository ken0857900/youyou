// 品牌故事「前路」：五层水墨山（three.js 着色器）＋一条往红日去的山路。往下滚动时整块钉住，墨线沿山路画上去，
// 走到哪个节点，左下的卡片就换成那一步；滑鼠移到节点上可以先看、点了跳过去；走到底出现「再按处境分群」和试试按钮。
// 手机（< 720px）一样钉住，改成上下排（story.css）；减少动态效果：不钉住，六步直接列出来。mount(root) 回传 cleanup
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Camera, Color, Mesh, PlaneGeometry, Scene, ShaderMaterial, Vector2, WebGLRenderer } from 'three';
import { COMMON, FULL_VS } from './homeScene.js';

gsap.registerPlugin(ScrollTrigger);

// 前路山水带：五层山脊（远淡近浓）＋流动的雾＋朱砂红日＋纸纹
const SHAN_FS = COMMON + `
  uniform float uTime, uScroll; uniform vec2 uMouse, uRes; uniform vec3 uPaper, uInk, uSun;
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes; float asp = uRes.x / uRes.y;
    vec3 col = uPaper;
    vec2 sp = vec2(.8 - uMouse.x*.02, .74 + uScroll*.1);
    float d = length((uv - sp) * vec2(asp, 1.));
    col = mix(col, uSun, smoothstep(.075, .07, d) * .85);
    for (int i = 0; i < 5; i++) {
      float k = float(i) / 4.;
      float x = uv.x*asp*(.9 + k*.9) + uScroll*(.15 + k*.7) + uMouse.x*(.02 + k*.08) + float(i)*7.3;
      float ridge = .66 - k*.12 + (fbm(vec2(x*1.1, float(i)*3.1)) - .5) * (.5 - k*.18);
      float below = smoothstep(ridge + .004, ridge - .004, uv.y);
      float wash = mix(.35, 1., smoothstep(ridge - .32, ridge, uv.y));
      float a = below * (.14 + k*.18) * wash * (.85 + .3*fbm(uv*vec2(40., 6.) + float(i)));
      col = mix(col, uInk, a);
      float mist = fbm(vec2(uv.x*2.2*asp - uTime*.025*(1. + k), uv.y*5. + float(i)*1.7));
      col = mix(col, uPaper, smoothstep(.5, .8, mist) * .45 * smoothstep(ridge, ridge - .25, uv.y) * below);
    }
    col += (hash(gl_FragCoord.xy) - .5) * .035;
    gl_FragColor = vec4(col, 1.);
  }`;

const AT = [.08, .25, .42, .58, .75, .92];  // 六个节点在山路上的位置（占全长比例）
const DRAW = .86;                              // 滚到 86% 时山路画完，剩下一段停在结果

// scroller：跟着谁捲（预设整页；放在「前路」面板里时传面板的捲动容器）
export function mount(root, scroller = window) {
  const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pin = motion;
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const offs = [];
  const on = (el, ev, fn) => { el.addEventListener(ev, fn); offs.push(() => el.removeEventListener(ev, fn)); };
  const color = (n) => new Color(getComputedStyle(document.documentElement).getPropertyValue(n).trim());
  root.classList.toggle('pin', pin);
  // 放在小视窗里：钉住的一屏＝小视窗的高度（CSS 的 vh 量的是整个视窗）
  const fit = () => { if (scroller !== window) root.style.setProperty('--stage-h', `${scroller.clientHeight}px`); };
  fit(); on(window, 'resize', fit);

  /* ===== 山路与节点 ===== */
  const ink = $('.lp-ink'), me = $('.lp-me'), L = ink.getTotalLength();
  const nodes = $$('.lp-node'), lis = $$('.lp-steps li');
  nodes.forEach((g, i) => { const pt = ink.getPointAtLength(AT[i] * L); g.setAttribute('transform', `translate(${pt.x} ${pt.y})`); });
  ink.style.strokeDasharray = L;

  /* ===== 水墨山（WebGL 起不来就只剩纸色底） ===== */
  const stage = $('.lp-stage');
  const u = { uTime: { value: 0 }, uScroll: { value: 0 }, uMouse: { value: new Vector2() }, uRes: { value: new Vector2() },
    uPaper: { value: color('--paper-2') }, uInk: { value: color('--fg') }, uSun: { value: color('--paper-2') } };  // 着色器的太阳涂成纸色＝关掉，红日改画在山路尽头（SVG）
  let r = null, draw = () => {};
  try { r = new WebGLRenderer({ canvas: $('canvas'), antialias: false }); } catch { /* 没有 WebGL */ }
  if (r) {
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    const scene = new Scene(), cam = new Camera();
    const mat = new ShaderMaterial({ uniforms: u, vertexShader: FULL_VS, fragmentShader: SHAN_FS });
    scene.add(new Mesh(new PlaneGeometry(2, 2), mat));
    draw = () => r.render(scene, cam);
    const size = () => { const w = stage.clientWidth, h = stage.clientHeight; r.setSize(w, h, false); u.uRes.value.set(w * r.getPixelRatio(), h * r.getPixelRatio()); draw(); };
    size(); on(window, 'resize', size);
    offs.push(() => { mat.dispose(); r.dispose(); r.forceContextLoss?.(); });
  }

  /* ===== 进度 → 画面 ===== */
  let reached = -1, hover = -1;
  const show = () => {
    const k = hover >= 0 ? hover : Math.max(reached, 0);
    lis.forEach((li, i) => li.classList.toggle('on', i === k));
    nodes.forEach((g, i) => { g.classList.toggle('done', i <= reached); g.classList.toggle('on', pin && i === k && (hover >= 0 || reached >= 0)); });
  };
  const set = (p) => {
    const q = Math.min(p / DRAW, 1);
    ink.style.strokeDashoffset = L * (1 - q);
    const pt = ink.getPointAtLength(q * L);
    me.setAttribute('cx', pt.x); me.setAttribute('cy', pt.y);
    reached = AT.filter((a) => q >= a - .01).length - 1;
    root.classList.toggle('end', p >= DRAW + .03);
    u.uScroll.value = p;
    show();
    draw();
  };

  /* ===== 收录数字：进画面时从 0 数上去 ===== */
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    if (motion) $$('.lp-cap b[data-n]').forEach((b) => { const o = { v: 0 }; gsap.to(o, { v: +b.dataset.n, duration: 1.6, ease: 'power2.out', onUpdate: () => { b.textContent = Math.round(o.v); } }); });
  }, { threshold: .3 });
  io.observe(root);
  offs.push(() => io.disconnect());

  if (!pin) { set(1); return () => offs.forEach((f) => f()); }

  const st = ScrollTrigger.create({ trigger: root, scroller, start: () => `top ${parseInt(getComputedStyle(stage).top) || 0}px`, end: 'bottom bottom', onUpdate: (s) => set(s.progress) });
  set(0);
  $('.lp-hint').textContent = window.matchMedia('(pointer: fine)').matches ? '往下滚动，沿着山路走；滑鼠移到节点上看每一步' : '往下滑，沿着山路走；点节点跳到那一步';

  // 节点：移上去先看，点了滚到那一步
  nodes.forEach((g, i) => {
    on(g, 'pointerenter', () => { hover = i; show(); });
    on(g, 'pointerleave', () => { hover = -1; show(); });
    on(g, 'click', () => scroller.scrollTo({ top: st.start + (AT[i] * DRAW + .005) * (st.end - st.start), behavior: 'smooth' }));
  });
  // 滑鼠左右移，山跟着微微错动；看不到时不画
  const mx = gsap.quickTo(u.uMouse.value, 'x', { duration: 1.2, ease: 'power3.out' });
  on(stage, 'pointermove', (e) => { const b = stage.getBoundingClientRect(); mx((e.clientX - b.left) / b.width * 2 - 1); });
  let vis = false;
  const vo = new IntersectionObserver(([e]) => { vis = e.isIntersecting; });
  vo.observe(stage);
  const tick = (t) => { if (vis) { u.uTime.value = t; draw(); } };
  gsap.ticker.add(tick);

  return () => {
    offs.forEach((f) => f());
    vo.disconnect();
    gsap.ticker.remove(tick);
    st.kill();
  };
}
