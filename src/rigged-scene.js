/** Build a measured, lightweight cutout rig for a Three.js scene. */
export function createRiggedMeasuredScene(THREE, rig, textures, scale = 0.01) {
  const root = new THREE.Group();
  root.name = 'measured-rig-root';

  const textureFor = (subject, record) => textures[record.assetId] || textures[`${subject.id}:${record.id}`] || textures[record.id];
  const makeCutout = (subject, record) => {
    const texture = textureFor(subject, record);
    if (!texture) throw new Error(`Missing texture for ${subject.id}/${record.id}`);
    const sourceSize = subject.sourceSizePx;
    const [width, height] = sourceSize;
    const material = new THREE.MeshBasicMaterial({ map: texture.clone(), transparent: true, depthWrite: false });
    material.map.repeat.set(1, 1);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width * scale, height * scale), material);
    mesh.name = record.id;
    mesh.renderOrder = record.layerOrder;
    return mesh;
  };

  const subjects = new Map();
  for (const subject of rig.subjects || []) {
    const group = new THREE.Group();
    group.name = `subject-${subject.id}`;
    group.userData = { classification: subject.classification, selectedStrategy: subject.selectedStrategy, joints: [] };
    const records = subject.parts || subject.bones || [];
    records.forEach((record, index) => {
      const joint = new THREE.Group();
      joint.name = `${subject.id}-${record.id}`;
      joint.userData = { index, pivotNormalized: record.pivotNormalized };
      joint.add(makeCutout(subject, record));
      group.add(joint);
      group.userData.joints.push(joint);
    });
    root.add(group);
    subjects.set(subject.id, group);
  }

  const applyPose = timeSec => {
    const phase = timeSec * Math.PI * 2 / rig.animation.loopPeriodSec;
    for (const subject of rig.subjects || []) {
      const group = subjects.get(subject.id);
      if (subject.selectedStrategy === 'segmented-cutout') {
        group.rotation.z = Math.sin(phase) * 0.018;
        group.userData.joints.forEach((joint, index) => {
          joint.rotation.z = Math.sin(phase + index * 1.1) * (index === 2 ? 0.025 : 0.075);
        });
      } else if (subject.selectedStrategy === 'spline-bands') {
        group.userData.joints.forEach((joint, index) => {
          const wave = Math.sin(phase * 1.35 - index * 0.72);
          joint.position.x = wave * (0.035 + index * 0.008);
          joint.rotation.z = wave * 0.08;
        });
      } else {
        group.position.y = Math.sin(phase) * 0.025;
        group.rotation.z = Math.sin(phase * .7) * 0.012;
      }
    }
  };

  return { root, subjects, applyPose };
}
