// Third-person over-the-shoulder camera with aim mode, sniper zoom and
// wall collision (backs off along the boom when geometry intrudes).

import * as THREE from 'three';
import { castSegment, type BoxCollider } from '../../shared/collision';
import { dirFromYawPitch, v3, type V3 } from '../../shared/math';

const BASE_FOV = 75;
const AIM_FOV = 58;
const ZOOM_FOV = 30;

export class TPCamera {
  cam: THREE.PerspectiveCamera;
  private dist = 4.2;
  private shoulder = 0.55;
  private fov = BASE_FOV;

  constructor(aspect: number) {
    this.cam = new THREE.PerspectiveCamera(BASE_FOV, aspect, 0.08, 500);
    this.cam.rotation.order = 'YXZ';
  }

  // pivot = player eye position (feet + eye height, error-smoothed)
  update(
    dt: number,
    pivot: V3,
    yaw: number,
    pit: number,
    aiming: boolean,
    zoomed: boolean,
    solids: BoxCollider[],
  ): void {
    const wantDist = aiming ? 2.0 : 4.2;
    const wantShoulder = aiming ? 0.75 : 0.55;
    const wantFov = zoomed ? ZOOM_FOV : aiming ? AIM_FOV : BASE_FOV;
    const k = 1 - Math.exp(-12 * dt);
    this.dist += (wantDist - this.dist) * k;
    this.shoulder += (wantShoulder - this.shoulder) * k;
    this.fov += (wantFov - this.fov) * k;

    const dir = dirFromYawPitch(yaw, pit);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    const target = v3(
      pivot.x + rightX * this.shoulder,
      pivot.y + 0.12,
      pivot.z + rightZ * this.shoulder,
    );
    let want = v3(target.x - dir.x * this.dist, target.y - dir.y * this.dist, target.z - dir.z * this.dist);

    const hit = castSegment(target, want, solids);
    if (hit) {
      const t = Math.max(hit.t - 0.28 / this.dist, 0.05);
      want = v3(
        target.x + (want.x - target.x) * t,
        target.y + (want.y - target.y) * t,
        target.z + (want.z - target.z) * t,
      );
    }
    if (want.y < 0.15) want.y = 0.15;

    this.cam.position.set(want.x, want.y, want.z);
    this.cam.rotation.set(pit, yaw, 0);
    if (Math.abs(this.cam.fov - this.fov) > 0.05) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }
  }

  ray(yaw: number, pit: number): { origin: V3; dir: V3 } {
    return {
      origin: v3(this.cam.position.x, this.cam.position.y, this.cam.position.z),
      dir: dirFromYawPitch(yaw, pit),
    };
  }

  setAspect(aspect: number): void {
    this.cam.aspect = aspect;
    this.cam.updateProjectionMatrix();
  }
}
