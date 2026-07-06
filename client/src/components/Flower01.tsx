import { useMemo } from 'react';
import * as THREE from 'three';
import { ThickEdges } from './OutlineMaterial';


export function Flower01({
    color = "#ffd700",
    scale = 1,
    connected = false,
    ...props
}) {

    const petals = useMemo(() => {
        const petalShape = new THREE.Shape()
            .moveTo(0, 0)
            .quadraticCurveTo(-1, 1, 0, 1.3)
            .quadraticCurveTo(1, 2, 0, 0);

        const geo = new THREE.ExtrudeGeometry(petalShape, {
            depth: 0.4,
            bevelEnabled: false
        });

        const count = 1;
        const radius = 0;

        const meshes = [];

        for (let i = 0; i < count; i++) {
            const angle = 1;

            meshes.push({
                position: [
                    Math.cos(angle) * radius,
                    Math.sin(angle) * radius,
                    0
                ],
                rotation: [0, 0, angle - Math.PI / 2],
                geometry: geo
            });
        }

        return meshes;
    }, []);

    return (
        <group {...props} scale={scale}>
            {petals.map((p, i) => (
                <group key={i}>
                    <mesh
                        geometry={p.geometry}
                        position={p.position}
                        rotation={p.rotation}
                    >
                        <meshStandardMaterial
                            color={color}
                            roughness={0.3}
                            metalness={0.6}
                            emissive={color}
                            emissiveIntensity={connected ? 1 : 0}
                        />
                    </mesh>
    
                    <ThickEdges geometry={p.geometry} />
                </group>
            ))}
        </group>
    );
}