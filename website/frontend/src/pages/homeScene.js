// 首页动画（照设计稿 逐页讨论.html）：水墨未名湖（three.js 着色器）、燕园四时轮播、往下滑区块浮上来
// mount(root) 回传 cleanup：离开首页时把监听、gsap 动画、WebGL 全部拿掉。减少动态效果时只画静止的一帧、轮播改成直接切换
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { Camera, Color, Mesh, PlaneGeometry, Scene, ShaderMaterial, Vector2, WebGLRenderer } from 'three';

gsap.registerPlugin(ScrollTrigger);

export const COMMON = `
  precision highp float;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float v = 0., a = .5; for (int i = 0; i < 5; i++) { v += a*noise(p); p *= 2.03; a *= .5; } return v; }
`;
export const FULL_VS = 'void main(){ gl_Position = vec4(position.xy, 0., 1.); }';
// 天空纸色渐层＋朱砂太阳＋远山淡墨＋树影＋博雅塔；水面是倒影＋水纹＋鼠标涟漪；叠上会晕开的墨、鼠标滴墨、聚向搜索框（uFocus）
const FS_LAKE = COMMON + `
  uniform vec3 uBg, uPaper, uInk, uAcc, uSun; uniform vec2 uRes, uM, uM2, uT;
  uniform float uTime, uFocus, uAmp;
  const float H = .3;
  float tower(vec2 p, float bx){
    float h = p.y - H; if (h < 0. || h > .44) return 0.;
    if (h > .39) return step(abs(p.x - bx), .004);
    float k = h / .39; float w = .03 * (1. - k*.5);
    float tier = fract(h / .03);
    return step(abs(p.x - bx), w + .01 * (1. - k*.4) * step(tier, .16));
  }
  vec3 sky(vec2 p, float asp){
    vec3 col = mix(uPaper, uBg, smoothstep(H, 1., p.y));
    float d = length(p - vec2(asp*.5, .8));
    col = mix(col, uSun, smoothstep(.06, .054, d) * .88);
    float far = H + .1 + (fbm(vec2(p.x*1.6, 1.)) - .5) * .22;
    col = mix(col, uInk, step(p.y, far) * .1 * (.7 + .6*fbm(p*vec2(30., 4.))));
    float trees = H + .025 + fbm(vec2(p.x*8., 3.)) * .06 + fbm(vec2(p.x*36., 7.)) * .018;
    float sil = max(step(p.y, trees) * (.55 + .3*fbm(p*vec2(60., 20.))), tower(p, asp*.66) * .85);
    return mix(col, uInk, sil);
  }
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes; float asp = uRes.x / uRes.y; vec2 p = vec2(uv.x*asp, uv.y);
    float tl = uTime;
    vec3 col;
    if (p.y >= H) col = sky(p, asp);
    else {
      float depth = H - p.y;
      float d = length((p - vec2(uM.x*asp, uM.y)) * vec2(1., 2.2));
      float rip = sin(d*80. - tl*7.) * exp(-d*7.) * uAmp;
      float wave = sin(p.y*140. + tl*1.4 + fbm(vec2(p.x*3., tl*.2))*6.) * .004 * (1. + depth*14.);
      vec2 q = vec2(p.x + wave + rip*.018, 2.*H - p.y + rip*.012 + depth*.05);
      col = mix(uPaper, sky(q, asp), .5);
      col = mix(col, uInk, smoothstep(.72, .9, noise(vec2(p.x*7., p.y*230. + tl*.6))) * .1);
      col = mix(col, uInk, abs(rip) * .12);
    }
    float t = uTime * .05;
    vec2 w = vec2(fbm(p*1.5 + t), fbm(p*1.5 + vec2(5.2, 1.3) - t));
    float f = fbm(p*2.1 + w*1.9);
    vec2 c = mix(vec2(asp*.42, .82), vec2(uT.x*asp, uT.y), uFocus*.8);
    float region = smoothstep(.75, .05, length((p - c) * vec2(.7, 1.1)));
    float e = (fbm(p*7. + t*4.) - .5) * .1;
    float drop = smoothstep(.12, .02, length(p - vec2(uM.x*asp, uM.y)) + e) + .7*smoothstep(.2, .03, length(p - vec2(uM2.x*asp, uM2.y)) + e);
    drop *= step(H, p.y);
    col = mix(col, uAcc, clamp(smoothstep(.35, .62, f)*region*.25 + drop*.3, 0., 1.));
    col = mix(col, uInk, clamp(smoothstep(.5, .72, f)*region*.7 + drop*.45*smoothstep(.3, .6, f + .15), 0., 1.));
    col += (hash(gl_FragCoord.xy) - .5) * .03;
    gl_FragColor = vec4(col, 1.);
  }`;
export function mount(root) {
  const motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const offs = [];  // cleanup
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); offs.push(() => el.removeEventListener(ev, fn, opt)); };
  const ctx = gsap.context(() => {}, root);
  const add = (fn) => ctx.add(fn);
  const color = (n) => new Color(getComputedStyle(document.documentElement).getPropertyValue(n).trim());
  const renderers = [];
  const ticks = [];
  const observers = [];
  const io = (fn, opt) => { const o = new IntersectionObserver(fn, opt); observers.push(o); return o; };

  function shader(canvas, box, uniforms, fs) {
    let r;
    try { r = new WebGLRenderer({ canvas, antialias: false }); } catch { return null; }
    renderers.push(r);
    r.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    const scene = new Scene(), cam = new Camera();
    const mat = new ShaderMaterial({ uniforms, vertexShader: FULL_VS, fragmentShader: fs });
    scene.add(new Mesh(new PlaneGeometry(2, 2), mat));
    const draw = () => r.render(scene, cam);
    const size = () => { const w = box.clientWidth, h = box.clientHeight; r.setSize(w, h, false); uniforms.uRes.value.set(w * r.getPixelRatio(), h * r.getPixelRatio()); draw(); };
    size(); on(window, 'resize', size);
    offs.push(() => { mat.dispose(); });
    return draw;
  }

  /* ===== hero：水墨未名湖 ===== */
  const hero = $('.hero');
  const U = { uTime: { value: 0 }, uRes: { value: new Vector2() }, uM: { value: new Vector2(.66, .15) }, uM2: { value: new Vector2(.66, .15) },
    uT: { value: new Vector2(.25, .5) }, uFocus: { value: 0 }, uAmp: { value: .4 },
    uBg: { value: color('--bg') }, uPaper: { value: color('--paper-2') }, uInk: { value: color('--fg') }, uAcc: { value: color('--accent') }, uSun: { value: color('--accent-2') } };
  const drawHero = shader($('.hero canvas'), hero, U, FS_LAKE);
  if (drawHero && motion) {
    $('.hero .hint').textContent = '湖面上划过起涟漪，天空上划过滴墨，点搜索框墨会聚过去';
    const m1 = { x: .66, y: .15 }, m2 = { x: .66, y: .15 };
    on(hero, 'pointermove', (e) => {
      const r = hero.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = 1 - (e.clientY - r.top) / r.height;
      gsap.to(m1, { x, y, duration: .6, ease: 'power3.out', overwrite: true });
      gsap.to(m2, { x, y, duration: 1.8, ease: 'power2.out', overwrite: true });
      gsap.fromTo(U.uAmp, { value: Math.max(U.uAmp.value, .9) }, { value: .15, duration: 2.4, ease: 'power2.out', overwrite: true });
    });
    const sbox = $('.hero .sbox');
    on(sbox, 'focusin', () => {  // 搜索框拿到焦点：墨往搜索框聚
      const h = hero.getBoundingClientRect(), r = sbox.querySelector('.s-row').getBoundingClientRect();
      U.uT.value.set((r.left + r.width * .7 - h.left) / h.width, 1 - (r.top + r.height / 2 - h.top) / h.height);
      gsap.to(U.uFocus, { value: 1, duration: 1.6, ease: 'power3.inOut', overwrite: true });
    });
    on(sbox, 'focusout', () => gsap.to(U.uFocus, { value: 0, duration: 1.6, ease: 'power3.inOut', overwrite: true }));
    let visible = true;
    io(([e]) => { visible = e.isIntersecting; }).observe(hero);
    const tick = (t) => { if (!visible) return; U.uTime.value = t; U.uM.value.set(m1.x, m1.y); U.uM2.value.set(m2.x, m2.y); drawHero(); };
    gsap.ticker.add(tick); ticks.push(tick);
  }
  if (motion) add(() => gsap.from('.hero-v', { clipPath: 'inset(0 0 100% 0)', duration: 1.6, ease: 'power3.inOut' }));  // 竖排大题从上往下展开

  /* ===== 搜索框提示：打字机轮播；有焦点就停 ===== */
  const EXAMPLES = ['双非金融大三，光华夏令营该报哪个方向', '统计学大三，光华学术营直博还是先读硕士', '光华高金没拿到优营，九推还来得及吗', '会计专业没有四大实习，能申光华会计硕士吗'];
  const ph = $('.s-fake span');
  ph.textContent = EXAMPLES[0];
  if (motion) {
    let ei = 0, ci = EXAMPLES[0].length, dir = -1, wait = 40;
    const id = setInterval(() => {
      if (document.activeElement === $('.s-fake')) return;
      if (wait > 0) { wait--; return; }
      ci += dir;
      if (ci <= 0) { ei = (ei + 1) % EXAMPLES.length; dir = 1; ci = 0; wait = 4; }
      else if (ci >= EXAMPLES[ei].length) { dir = -1; wait = 40; }
      ph.textContent = EXAMPLES[ei].slice(0, Math.max(ci, 0)) + (dir > 0 ? '▌' : '');
    }, 70);
    offs.push(() => clearInterval(id));
  }

  /* ===== 横排（燕园四时窄屏、推荐分享者）：滑鼠滚轮在上面时改成左右捲，捲到头才放给整页 ===== */
  // 有 scroll-snap，一点点捲会被吸回原位 → 一格滚轮捲一张卡，捲动中的滚轮吃掉
  $$('.seasons, .people').forEach((strip) => { let wheelBusy = false; on(strip, 'wheel', (e) => {
    const max = strip.scrollWidth - strip.clientWidth;
    if (max <= 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    if ((e.deltaY > 0 && strip.scrollLeft >= max - 1) || (e.deltaY < 0 && strip.scrollLeft <= 0)) return;
    e.preventDefault();
    if (wheelBusy) return;
    wheelBusy = true;
    strip.scrollBy({ left: Math.sign(e.deltaY) * strip.firstElementChild.offsetWidth, behavior: motion ? 'smooth' : 'auto' });
    setTimeout(() => { wheelBusy = false; }, 450);
  }, { passive: false }); });

  /* ===== 往下滑时区块浮上来：一开始在画面下方的才先藏起来，同一批依序错开 90ms，只播一次 ===== */
  if (motion) {
    const els = $$('.lake-intro, .season, .sec-head, .cat, .ktab, .rank li, .board, .person');
    els.forEach((el) => { el.classList.add('rv'); if (el.getBoundingClientRect().top > window.innerHeight) el.classList.add('pre'); });
    const o = io((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e, k) => {
        e.target.style.transitionDelay = `${k * 90}ms`;
        e.target.classList.remove('pre');
        o.unobserve(e.target);
        setTimeout(() => { e.target.style.transitionDelay = ''; }, 1200 + k * 90);
      });
    }, { rootMargin: '0px 0px -10% 0px', threshold: .12 });
    els.forEach((el) => { if (el.classList.contains('pre')) o.observe(el); });
  }

  return () => {
    offs.forEach((f) => f());
    observers.forEach((o) => o.disconnect());
    ticks.forEach((t) => gsap.ticker.remove(t));
    ctx.revert();
    renderers.forEach((r) => { r.dispose(); r.forceContextLoss?.(); });
  };
}
