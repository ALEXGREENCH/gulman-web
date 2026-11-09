import { Ray, Triangle, Vector3 } from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';

const EPSILON = 1e-5;
const DOWN = new Vector3(0, -1, 0);

/** Static triangle collision in metres, Y up. Positions are at the player's feet.
 * Input meshes must already have their world scale/rotation applied to the graph.
 * Set velocity.y to a positive jump speed before move(); gravity is applied here.
 * Both windings collide: several original levels have inconsistent face normals.
 */
export class WorldCollision {
  constructor({ radius = 0.32, height = 1.75, stepHeight = 0.35, gravity = 22, maxSlope = 50 } = {}) {
    if (!(radius > 0 && height >= radius * 2 && stepHeight >= 0 && gravity >= 0)) {
      throw new RangeError('Invalid player collision dimensions');
    }
    this.radius = radius;
    this.height = height;
    this.stepHeight = stepHeight;
    this.gravity = gravity;
    this.slopeCos = Math.cos(maxSlope * Math.PI / 180);
    this.tree = new Octree();
    this.triangleCount = 0;
    this._capsule = new Capsule(new Vector3(), new Vector3(), radius);
    this._normal = new Vector3();
    this._center = new Vector3();
    this._point = new Vector3();
    this._oriented = new Triangle();
    this._ray = new Ray();
    this._candidates = [];
  }

  clear() {
    this.tree.clear();
    this.triangleCount = 0;
    return this;
  }

  setWorld(group, { support = [], exclude } = {}) {
    this.clear();
    group.updateWorldMatrix(true, true);
    group.traverse(object => {
      if (!object.isMesh || object.userData.collision === false) return;
      const attribute = object.geometry?.getAttribute('position');
      if (!attribute) return;
      const index = object.geometry.index;
      const count = index ? index.count : attribute.count;
      for (let i = 0; i + 2 < count; i += 3) {
        const points = [0, 1, 2].map(offset => new Vector3()
          .fromBufferAttribute(attribute, index ? index.getX(i + offset) : i + offset)
          .applyMatrix4(object.matrixWorld));
        const triangle = new Triangle(...points);
        if (!points.every(p => Number.isFinite(p.x + p.y + p.z)) || triangle.getArea() < 1e-10 || exclude?.(points)) continue;
        this.tree.addTriangle(triangle);
        this.triangleCount++;
      }
    });
    for (const triangle of support) { this.tree.addTriangle(triangle); this.triangleCount++; }
    if (this.triangleCount) this.tree.build();
    return this;
  }

  /** Closest two-sided static-world hit, or null. Direction need not be unit length. */
  ray(origin, direction, maxDistance = Infinity) {
    return this._cast(origin, direction, maxDistance, false);
  }

  /** Highest walkable surface below the supplied point, bounded by maxDrop. */
  ground(x, y, z, maxDrop = 100) {
    const hit = this._cast(new Vector3(x, y, z), DOWN, maxDrop, true);
    return hit?.position.y;
  }

  _cast(origin, direction, maxDistance, walkableOnly) {
    if (!this.triangleCount || maxDistance < 0 || direction.lengthSq() < 1e-16) return null;
    this._ray.origin.copy(origin);
    this._ray.direction.copy(direction).normalize();
    this._candidates.length = 0;
    this.tree.getRayTriangles(this._ray, this._candidates);
    let best = null;
    for (const triangle of this._candidates) {
      triangle.getNormal(this._normal);
      if (walkableOnly && Math.abs(this._normal.y) < this.slopeCos) continue;
      if (!this._ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, this._point)) continue;
      const distance = this._point.distanceTo(origin);
      if (distance > maxDistance + EPSILON || (best && distance >= best.distance)) continue;
      const normal = this._normal.clone();
      if (normal.dot(this._ray.direction) > 0) normal.negate();
      best = { distance, position: this._point.clone(), normal, triangle };
    }
    return best;
  }

  _setCapsule(position) {
    this._capsule.start.set(position.x, position.y + this.radius, position.z);
    this._capsule.end.set(position.x, position.y + this.height - this.radius, position.z);
  }

  _resolve(position, velocity = null, holdGround = false) {
    if (!this.triangleCount) return { onGround: false, blocked: false };
    this._setCapsule(position);
    let onGround = false;
    let blocked = false;
    for (let pass = 0; pass < 5; pass++) {
      this._candidates.length = 0;
      this.tree.getCapsuleTriangles(this._capsule, this._candidates);
      let corrected = false;
      for (const triangle of this._candidates) {
        triangle.getNormal(this._normal);
        this._capsule.getCenter(this._center);
        // Octree's capsule test is one-sided. Orient each candidate towards
        // the capsule; substeps keep its centre from crossing a thin wall.
        const side = this._normal.dot(this._center.sub(triangle.a));
        const face = side < 0 ? this._oriented.set(triangle.c, triangle.b, triangle.a) : triangle;
        const hit = this.tree.triangleCapsuleIntersect(this._capsule, face);
        if (!hit || hit.depth <= EPSILON || !Number.isFinite(hit.depth)) continue;
        corrected = true;
        if (hit.normal.y >= this.slopeCos) {
          onGround = true;
          if (holdGround) {
            // Remove downward penetration without turning gravity into
            // horizontal movement while the player is standing still.
            this._capsule.translate(this._normal.set(0, hit.depth / hit.normal.y + EPSILON, 0));
            continue;
          }
        }
        else if (Math.abs(hit.normal.y) < this.slopeCos) blocked = true;
        if (hit.normal.y > 0 && hit.normal.y < this.slopeCos) {
          // Treat steep slopes like walls. Projecting horizontally into a
          // steep plane's full normal otherwise turns walking into climbing.
          hit.normal.y = 0;
          const horizontalLength = hit.normal.length();
          hit.normal.divideScalar(horizontalLength);
          hit.depth /= horizontalLength;
        }
        if (velocity) {
          const into = velocity.dot(hit.normal);
          if (into < 0) velocity.addScaledVector(hit.normal, -into);
        }
        this._capsule.translate(hit.normal.multiplyScalar(hit.depth + EPSILON));
      }
      if (!corrected) break;
    }
    position.set(this._capsule.start.x, this._capsule.start.y - this.radius, this._capsule.start.z);
    return { onGround, blocked };
  }

  _support(position, top, maxDrop) {
    const r = this.radius;
    const samples = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r],
      [r * .7, r * .7], [-r * .7, r * .7], [r * .7, -r * .7], [-r * .7, -r * .7]];
    let highest;
    for (const [x, z] of samples) {
      const height = this.ground(position.x + x, top, position.z + z, maxDrop);
      if (height !== undefined) highest = highest === undefined ? height : Math.max(highest, height);
    }
    return highest;
  }

  _step(from, desired) {
    const top = this._support(desired, from.y + this.stepHeight + EPSILON, this.stepHeight + EPSILON * 2);
    if (top === undefined) return null;
    if (top <= from.y + .015 || top - from.y > this.stepHeight + EPSILON) return null;
    // Sweep upwards as well as forwards, so stepping never tunnels through
    // a low ceiling or around a corner.
    const lifted = from.clone();
    const rise = top - from.y + EPSILON * 2;
    const increments = Math.ceil(rise / (this.radius * .3));
    for (let i = 1; i <= increments; i++) {
      lifted.set(from.x, from.y + rise * i / increments, from.z);
      const intended = lifted.clone();
      this._resolve(lifted);
      if (lifted.distanceToSquared(intended) > 1e-6) return null;
    }
    lifted.x = desired.x;
    lifted.z = desired.z;
    const intended = lifted.clone();
    this._resolve(lifted);
    if (lifted.distanceToSquared(intended) > 1e-5) return null;
    return lifted;
  }

  /** Mutates feet position and velocity; returns { onGround, blocked }.
   * Reapply desired horizontal velocity each frame. A positive vertical input
   * starts a jump even when the preceding frame was grounded. Frame gaps above
   * 0.25 s are intentionally clamped; the game should pause when not visible.
   */
  move(position, velocity, dt, onGround = false) {
    if (!Number.isFinite(dt) || dt <= 0) return { onGround, blocked: false };
    dt = Math.min(dt, .25);
    const distance = (velocity.length() + this.gravity * dt) * dt;
    const steps = Math.max(1, Math.ceil(dt * 90), Math.ceil(distance / (this.radius * .3)));
    const slice = dt / steps;
    const idle = velocity.x === 0 && velocity.z === 0;
    let grounded = onGround && velocity.y <= .01;
    let blocked = false;
    for (let i = 0; i < steps; i++) {
      const wasGrounded = grounded;
      const jumping = velocity.y > .01;
      const before = position.clone();
      const horizontal = new Vector3(velocity.x, 0, velocity.z);
      // A landing at speed still uses the usual collision response.
      const holdGround = idle && !jumping && (wasGrounded || velocity.y >= -.2);
      velocity.y -= this.gravity * slice;
      position.addScaledVector(velocity, slice);
      const desired = position.clone();
      const collision = this._resolve(position, velocity, holdGround);
      // A walkable contact is support even while moving up a slope. Its
      // response can generate positive Y velocity, which is not a jump.
      grounded = collision.onGround;
      blocked ||= collision.blocked;
      const lostHorizontal = Math.hypot(position.x - desired.x, position.z - desired.z);
      if (wasGrounded && !jumping && collision.blocked && lostHorizontal > EPSILON) {
        const raised = this._step(before, desired);
        if (raised) {
          position.copy(raised);
          velocity.set(horizontal.x, 0, horizontal.z);
          grounded = true;
        }
      }
      // Follow small downward steps; don't attract a jumping player to ground.
      if (!grounded && wasGrounded && !jumping && velocity.y <= 0) {
        const ground = this._support(position, position.y + .02, this.stepHeight + .04);
        if (ground !== undefined && ground <= position.y + .02) {
          position.y = ground + EPSILON;
          this._resolve(position, velocity, holdGround);
          velocity.y = 0;
          grounded = true;
        }
      }
      if (grounded) velocity.y = 0;
    }
    return { onGround: grounded, blocked };
  }
}
