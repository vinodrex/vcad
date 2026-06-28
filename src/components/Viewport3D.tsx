import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { PreviewBody } from "../cad/model";

interface Viewport3DProps {
  bodies: PreviewBody[];
}

function materialFor(operation: string) {
  if (operation === "cut") {
    return new THREE.MeshStandardMaterial({ color: 0xd95f59, transparent: true, opacity: 0.42, roughness: 0.58 });
  }
  if (operation === "add") {
    return new THREE.MeshStandardMaterial({ color: 0x2c9d8f, roughness: 0.48, metalness: 0.08 });
  }
  return new THREE.MeshStandardMaterial({ color: 0x5b7f95, roughness: 0.5, metalness: 0.12 });
}

function meshFor(body: PreviewBody) {
  let geometry: THREE.BufferGeometry;
  if (body.kind === "box") {
    geometry = new THREE.BoxGeometry(body.width, body.height, body.depth);
  } else if (body.kind === "cylinder") {
    geometry = new THREE.CylinderGeometry(body.radius, body.radius, body.height, 48);
  } else if (body.kind === "tube") {
    const outer = new THREE.CylinderGeometry(body.outerRadius, body.outerRadius, body.height, 64, 1, true);
    const inner = new THREE.CylinderGeometry(body.innerRadius, body.innerRadius, body.height * 1.01, 64, 1, true);
    const groupGeometry = new THREE.BufferGeometry();
    geometry = groupGeometry.copy(outer);
    inner.dispose();
  } else if (body.kind === "torus") {
    geometry = new THREE.TorusGeometry(body.majorRadius, body.tubeRadius, 16, 64);
  } else {
    geometry = new THREE.CylinderGeometry(body.radiusTop, body.radiusBottom, body.height, 48);
  }
  const mesh = new THREE.Mesh(geometry, materialFor(body.operation));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function Viewport3D({ bodies }: Viewport3DProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const modelRef = useRef<THREE.Group | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f7f8);
    const camera = new THREE.PerspectiveCamera(42, host.clientWidth / host.clientHeight, 0.1, 2000);
    camera.position.set(115, 95, 135);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.shadowMap.enabled = true;
    host.appendChild(renderer.domElement);

    const ambient = new THREE.HemisphereLight(0xffffff, 0xcfd8d7, 2.3);
    scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(80, 120, 90);
    key.castShadow = true;
    scene.add(key);

    const grid = new THREE.GridHelper(180, 18, 0x9aa7a8, 0xd1dadb);
    grid.position.y = -35;
    scene.add(grid);

    const model = new THREE.Group();
    scene.add(model);
    sceneRef.current = scene;
    modelRef.current = model;

    let animationId = 0;
    const resizeObserver = new ResizeObserver(() => {
      if (!host.clientWidth || !host.clientHeight) return;
      camera.aspect = host.clientWidth / host.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(host.clientWidth, host.clientHeight);
    });
    resizeObserver.observe(host);

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      model.rotation.y += 0.003;
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
      renderer.dispose();
      host.removeChild(renderer.domElement);
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) {
            object.material.forEach((material) => material.dispose());
          } else {
            object.material.dispose();
          }
        }
      });
      sceneRef.current = null;
      modelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const model = modelRef.current;
    if (!model) return;
    model.clear();
    bodies.forEach((body, index) => {
      const mesh = meshFor(body);
      mesh.position.x = (index - (bodies.length - 1) / 2) * 16;
      if (body.kind === "box") {
        mesh.rotation.y = 0.08;
      }
      model.add(mesh);
    });
  }, [bodies]);

  return <div ref={hostRef} className="viewport-3d" aria-label="3D model preview" />;
}
