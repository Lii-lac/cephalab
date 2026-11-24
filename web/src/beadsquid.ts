// @ts-nocheck
// Ported as-is from mockups/v52.template.html (section "squid"); behaviour must match v52.
import THREE_URL from "../../assets/three-r159.min.js?url";

export const beadSquid = (() => {
  let T = window.THREE, loadStarted = false;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const holder = document.createElement('span');
  holder.className = 'bead-squid';
  holder.setAttribute('aria-hidden', 'true');
  holder.innerHTML = '<svg viewBox="142 49 193 200"><use href="#beadsquid-squid" x="142" y="49" width="193" height="200"/></svg>';
  const fallback = holder.firstElementChild;
  let model, failed = false, request = 0, visible = false, start = 0, elapsed = 0;

  function point(x, y) {
    const dx = (x - 323) / 100, dy = (56 - y) / 100;
    return [(dx - dy) * Math.SQRT1_2, (dx + dy) * Math.SQRT1_2];
  }
  function outline(id) {
    const parts = document.getElementById('beadsquid-' + id).getAttribute('d').match(/[MCZ]|-?\d+(?:\.\d+)?/g);
    const shape = new T.Shape();
    for (let i = 0; i < parts.length;) {
      const verb = parts[i++];
      const p = () => point(+parts[i++], +parts[i++]);
      if (verb === 'M') shape.moveTo(...p());
      else if (verb === 'C') shape.bezierCurveTo(...p(), ...p(), ...p());
      else shape.closePath();
    }
    return shape;
  }
  function bodyMesh() {
    const g = new T.ExtrudeGeometry(outline('body'), {
      depth: .23, curveSegments: 10, bevelEnabled: true,
      bevelThickness: .078, bevelSize: .032, bevelSegments: 4
    });
    const position = g.attributes.position, colors = [];
    const head = new T.Color('#eeff40'), tail = new T.Color('#deff2e');
    const ink = new T.Color();
    for (let i = 0; i < position.count; i++) {
      const z = position.getZ(i) - .115;
      const along = T.MathUtils.clamp(-position.getY(i) / 2.49, 0, 1);
      const depth = .24 + .76 * Math.sin(Math.PI * Math.pow(along, .76));
      position.setZ(i, z * depth);
      ink.copy(head).lerp(tail, along).multiplyScalar(.975 + .025 * z / .193);
      colors.push(ink.r, ink.g, ink.b);
    }
    g.setAttribute('color', new T.Float32BufferAttribute(colors, 3));
    return new T.Mesh(g, new T.MeshBasicMaterial({vertexColors: true}));
  }
  function faceMesh() {
    const face = new T.Group();
    const dark = new T.MeshBasicMaterial({color: '#21191c'});
    const white = new T.MeshBasicMaterial({color: '#fffefd'});
    const shape = outline('eyes');
    const eyeGeo = new T.ExtrudeGeometry(shape, {
      curveSegments: 10, depth: .024, bevelEnabled: true,
      bevelSize: .008, bevelThickness: .009, bevelSegments: 2
    });
    const rim = new T.Mesh(eyeGeo, dark);
    rim.position.set(...point(319.5, 60.4), .173);
    face.add(rim);
    const whites = new T.Mesh(eyeGeo, white);
    whites.position.z = .200;
    face.add(whites);
    const pupilGeo = new T.CircleGeometry(1, 40);
    for (const [x,y,rx,ry,deg] of [[249,111.1,11.1,13.4,31],[275.5,137.3,11.8,13.1,43]]) {
      const pupil = new T.Mesh(pupilGeo, dark);
      pupil.position.set(...point(x,y), .235);
      pupil.scale.set(rx / 100, ry / 100, 1);
      pupil.rotation.z = Math.PI / 4 - T.MathUtils.degToRad(deg);
      face.add(pupil);
    }
    return face;
  }
  const fps = 30, period = 71;
  // Frame, stretch along the axis, width, unwrapped roll, screen lean.
  const poses = [
    [0,.79,1.03,0,-44], [2,.77,1.04,0,-44], [3,.82,1.03,2,-44],
    [4,.98,.92,20,-44], [5,1.17,.82,50,-45], [6,1.36,.75,78,-45],
    [7,1.49,.40,111,-45], [8,1.53,.40,147,-45], [9,1.54,.60,181,-45],
    [10,1.53,.40,217,-45], [11,1.47,.53,253,-45], [12,1.35,.69,284,-45],
    [13,1.18,.83,312,-45], [14,1.03,.88,338,-44], [15,.91,.98,352,-44],
    [17,.83,1.02,360,-44], [20,.77,1.04,360,-44], [21,.77,1.04,360,-44],
    [23,1.03,.98,360,-45], [27,1.35,.86,360,-46], [31,1.02,.97,360,-45],
    [35,.83,1.02,360,-44], [38,.77,1.04,360,-44], [44,1.35,.86,360,-46],
    [49,1.01,.97,360,-45], [54,.77,1.04,360,-44], [56,.77,1.04,360,-44],
    [62,1.35,.86,360,-46], [66,1.02,.97,360,-45], [71,.79,1.03,360,-44]
  ];
  // Wrapped neighboring samples give the loop the same velocity on either
  // side of its seam. Monotone cubic interpolation avoids overshoot.
  const prior = [66-period,1.02,.97,0,-45], following = [period+2,.77,1.04,360,-44];
  function slope(p, q, r, k) {
    const a = (q[k] - p[k]) / (q[0] - p[0]), b = (r[k] - q[k]) / (r[0] - q[0]);
    return a*b > 0 ? 2*a*b/(a+b) : 0;
  }
  function at(frame) {
    const i = poses.findIndex(p => p[0] > frame) - 1;
    const a = poses[i], b = poses[i+1], span = b[0]-a[0];
    const u = (frame-a[0])/span, u2=u*u, u3=u2*u;
    return [1,2,3,4].map(k => (2*u3-3*u2+1)*a[k] - (2*u3-3*u2)*b[k] +
      u*(u-1)**2*span*slope(poses[i-1] ?? prior,a,b,k) +
      (u3-u2)*span*slope(a,b,poses[i+2] ?? following,k));
  }

  function setup() {
    const scene = new T.Scene();
    const camera = new T.OrthographicCamera(-2.14, 2.14, 2.14, -2.14, .1, 20);
    camera.position.z = 6;
    const screen = new T.Group(), roll = new T.Group(), face = faceMesh();
    screen.position.set(1.38, 1.53, 0);
    screen.add(roll);
    roll.add(bodyMesh(), face);
    scene.add(screen);
    const canvas = document.createElement('canvas');
    canvas.hidden = true;
    const renderer = new T.WebGLRenderer({canvas, alpha: true, antialias: true});
    renderer.setClearColor(0x000000, 0);
    canvas.addEventListener('webglcontextlost', event => {
      event.preventDefault();
      failed = true;
      sync();
    });
    canvas.addEventListener('webglcontextrestored', () => { failed = false; sync(); });
    holder.append(canvas);
    return {scene, camera, renderer, screen, roll, face, canvas};
  }
  function draw(time) {
    const {scene, camera, renderer, screen, roll, face, canvas} = model;
    const [length,width,turn,tilt] = at(Math.max(0,time)*fps/1000 % period);
    screen.rotation.z = T.MathUtils.degToRad(tilt);
    roll.rotation.y = -T.MathUtils.degToRad(turn);
    roll.scale.set(width, length, 1 + (length-.79)*1.08);
    const eyeScale = (1 + (length-.79)*.28) / (length/.79);
    face.scale.y = eyeScale;
    face.position.y = -1.01 * (1-eyeScale);
    const size = Math.round(74 * Math.min(window.devicePixelRatio || 1, 2));
    if (canvas.width !== size || canvas.height !== size) renderer.setSize(size, size, false);
    renderer.render(scene, camera);
  }
  function frame(time) {
    try {
      draw(time - start);
      request = requestAnimationFrame(frame);
    } catch {
      request = 0;
      failed = true;
      layers(false);
    }
  }
  function layers(animated) {
    if (model) model.canvas.hidden = !animated;
    fallback.toggleAttribute('hidden', animated);
  }
  function loadModelLibrary() {
    if (loadStarted) return;
    loadStarted = true;
    const script = document.createElement('script');
    script.async = true;
    script.src = THREE_URL;
    script.onload = () => { T = window.THREE; failed = !T; sync(); };
    script.onerror = () => { failed = true; sync(); };
    document.head.append(script);
  }
  function sync() {
    if (failed || reduce.matches || !visible || document.hidden) {
      if (request) {
        cancelAnimationFrame(request);
        request = 0;
        elapsed = performance.now() - start;
      }
      layers(false);
    } else if (!T) {
      loadModelLibrary();
    } else if (!request) {
      try {
        model ??= setup();
        draw(elapsed);
        layers(true);
        start = performance.now() - elapsed;
        request = requestAnimationFrame(frame);
      } catch {
        failed = true;
        layers(false);
      }
    }
  }
  const observe = new IntersectionObserver(entries => { visible = entries[entries.length - 1].isIntersecting; sync(); });
  reduce.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  observe.observe(holder);
  return bead => { if (bead && holder.parentNode !== bead) bead.append(holder); };
})();
