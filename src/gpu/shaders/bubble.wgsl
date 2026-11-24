// 泡泡渲染：全屏三角形 + 片元级光线-球面求交（无顶点/索引缓冲，亚像素法线）。
// 最多 6 个泡泡实例。膜厚纹理为 rgba32float（不可过滤），用 textureLoad 手动双线性；
// 干涉 LUT 为 rgba16float（可过滤），用 textureSample。
// 注意：全函数保持 uniform 控制流，不提前 return，保证 textureSample 合法。

struct BubbleInstance {
  center: vec3<f32>,
  radius: f32,
  hLayer: f32,
  popProgress: f32,
  wobble: f32,
  _pad: f32,
};
struct CameraUniforms {
  invViewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  hMax: f32,
  angleMax: f32,
  count: u32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};
@group(0) @binding(0) var<uniform> cam: CameraUniforms;
@group(0) @binding(1) var<storage, read> instances: array<BubbleInstance>;
@group(0) @binding(2) var hTex: texture_2d_array<f32>;
@group(0) @binding(3) var lutTex: texture_2d<f32>;
@group(0) @binding(4) var lutSmp: sampler;

struct VSOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) ray0: vec3<f32>,
  @location(1) ray1: vec3<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var out: VSOut;
  let p = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0), vec2<f32>(3.0, 1.0), vec2<f32>(-1.0, 1.0),
  );
  let xy = p[vi];
  out.clip = vec4<f32>(xy, 0.0, 1.0);
  let near = cam.invViewProj * vec4<f32>(xy, 0.0, 1.0);
  let far = cam.invViewProj * vec4<f32>(xy, 1.0, 1.0);
  out.ray0 = near.xyz / near.w;
  out.ray1 = far.xyz / far.w;
  return out;
}

fn linearToSRGB(c: f32) -> f32 {
  let v = clamp(c, 0.0, 1.0);
  return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, 12.92 * v, v <= 0.0031308);
}

// 膜厚纹理手动双线性（经度周期回绕、纬度钳制），rgba32float 不能用过滤采样器
fn sampleThickness(uv: vec2<f32>, layer: i32) -> f32 {
  let dims = textureDimensions(hTex);
  let fx = uv.x * f32(dims.x);
  let fy = clamp(uv.y, 0.0, 1.0) * f32(dims.y);
  let x0raw = i32(floor(fx));
  let y0 = clamp(i32(floor(fy)), 0, i32(dims.y) - 1);
  let y1 = min(y0 + 1, i32(dims.y) - 1);
  let x0 = ((x0raw % i32(dims.x)) + i32(dims.x)) % i32(dims.x);
  let x1 = (x0 + 1) % i32(dims.x);
  let tx = fract(fx);
  let ty = fy - floor(fy);
  let a = textureLoad(hTex, vec2<i32>(x0, y0), layer, 0).r;
  let b = textureLoad(hTex, vec2<i32>(x1, y0), layer, 0).r;
  let c = textureLoad(hTex, vec2<i32>(x0, y1), layer, 0).r;
  let d = textureLoad(hTex, vec2<i32>(x1, y1), layer, 0).r;
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

struct HitPayload {
  hit: bool,
  depth: f32,
  color: vec4<f32>,
};

// 全程 uniform 控制流：未命中也走完计算，最后用 hit 标志选择
fn renderBubble(inst: BubbleInstance, rayOrigin: vec3<f32>, rayDir: vec3<f32>) -> HitPayload {
  var payload: HitPayload;
  payload.hit = false;
  payload.depth = 1e30;
  payload.color = vec4<f32>(0.0);

  let oc = rayOrigin - inst.center;
  let b = dot(oc, rayDir);
  let c = dot(oc, oc) - inst.radius * inst.radius;
  let disc = b * b - c;
  let valid = disc >= 0.0;
  let tSafe = select(0.0, -b - sqrt(max(disc, 0.0)), valid);
  let inFront = tSafe >= 0.0;
  let isHit = valid && inFront;

  let worldPos = rayOrigin + rayDir * tSafe;
  var normal = normalize(worldPos - inst.center);
  let wob = inst.wobble;
  normal = normalize(normal + vec3<f32>(
    sin(worldPos.y * 7.0 + wob), cos(worldPos.x * 6.0 + wob * 1.3), 0.0,
  ) * 0.015);

  let viewDir = -rayDir;
  let cosI = clamp(abs(dot(viewDir, normal)), 0.0, 1.0);
  let thetaI = acos(cosI);

  let theta = acos(clamp(normal.y, -1.0, 1.0));
  let phi = atan2(normal.z, normal.x) + 3.14159265;
  let uv = vec2<f32>(phi / 6.2831853, theta / 3.14159265);
  let layer = i32(inst.hLayer);
  let h = sampleThickness(uv, layer);

  let u = clamp(h / cam.hMax, 0.0, 1.0);
  let v = clamp(thetaI / cam.angleMax, 0.0, 1.0);
  let inter = textureSample(lutTex, lutSmp, vec2<f32>(u, v)).rgb;

  let fresnel = pow(1.0 - cosI, 3.0) * 0.6 + 0.55;
  var color = inter * fresnel;

  let blackness = 1.0 - smoothstep(0.0, 0.06, h / cam.hMax);
  color = color + vec3<f32>(0.012, 0.015, 0.02) * blackness;

  var alpha = clamp(0.10 + dot(color, vec3<f32>(0.3)) * 0.7, 0.05, 0.85);
  if (inst.popProgress > 0.0) {
    let topFactor = normal.y * 0.5 + 0.5;
    let vanish = smoothstep(inst.popProgress - 0.15, inst.popProgress + 0.15, topFactor);
    let flicker = 0.5 + 0.5 * sin(worldPos.x * 60.0 + worldPos.z * 40.0);
    color = color * (1.0 - vanish) + vec3<f32>(1.0, 0.95, 0.8) * vanish * flicker * 0.4;
    // 完全消散的片元通过 hit=false 丢弃，而非提前 return
    let fullyGone = vanish > 0.98;
    alpha = alpha * (1.0 - vanish);
    if (fullyGone) {
      payload.hit = false;
      payload.color = vec4<f32>(linearToSRGB(color.r), linearToSRGB(color.g), linearToSRGB(color.b), 0.0);
      return payload;
    }
  }

  payload.hit = isHit;
  payload.depth = tSafe;
  payload.color = vec4<f32>(
    linearToSRGB(color.r), linearToSRGB(color.g), linearToSRGB(color.b), alpha,
  );
  return payload;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let rayOrigin = in.ray0;
  let rayDir = normalize(in.ray1 - in.ray0);
  var best: HitPayload;
  best.hit = false;
  best.depth = 1e30;
  best.color = vec4<f32>(0.0);
  for (var i = 0u; i < cam.count; i = i + 1u) {
    let p = renderBubble(instances[i], rayOrigin, rayDir);
    if (p.hit && p.depth < best.depth) { best = p; }
  }
  if (!best.hit) { discard; }
  return best.color;
}
