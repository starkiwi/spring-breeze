import { useRef, useMemo, useState, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text3D, Center } from '@react-three/drei';
import * as THREE from 'three';

const FrontFaceEdges = ({ geometry }: { geometry: THREE.BufferGeometry }) => {
    const edgeGeo = useMemo(() => {
        // Generate all sharp edges first (threshold angle 15 degrees)
        const edges = new THREE.EdgesGeometry(geometry, 15);
        const pos = edges.attributes.position.array;

        // Find the maximum Z value (Front face typically has the highest Z)
        let maxZ = -Infinity;
        for (let i = 0; i < pos.length; i += 3) {
            if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
        }

        // Filter edges to keep only those on the front face (Z ~= maxZ)
        const filteredPoints = [];
        const epsilon = 0.01;

        for (let i = 0; i < pos.length; i += 6) {
            const z1 = pos[i + 2];
            const z2 = pos[i + 5];

            // Both vertices of the edge must be on the front face
            if (Math.abs(z1 - maxZ) < epsilon && Math.abs(z2 - maxZ) < epsilon) {
                filteredPoints.push(
                    pos[i], pos[i + 1], pos[i + 2],
                    pos[i + 3], pos[i + 4], pos[i + 5]
                );
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(filteredPoints, 3));
        return geo;
    }, [geometry]);

    return (
        <lineSegments geometry={edgeGeo}>
            <lineBasicMaterial
                color={new THREE.Color("#00ffcc").multiplyScalar(3)} // High intensity glow
                toneMapped={false}
                linewidth={1}
                transparent
                opacity={1.0}
            />
        </lineSegments>
    );
};

export function PolarWindsTitle() {
    const meshRef = useRef<THREE.Mesh>(null);
    const [geo, setGeo] = useState<THREE.BufferGeometry | null>(null);

    const fontUrl = "https://raw.githubusercontent.com/mrdoob/three.js/master/examples/fonts/helvetiker_bold.typeface.json";

    useEffect(() => {
        if (meshRef.current?.geometry) {
            setGeo(meshRef.current.geometry);
        }
    }, []);

    useFrame(() => {
        if (!geo && meshRef.current?.geometry) {
            setGeo(meshRef.current.geometry);
        }
    });

    return (
        <Center position={[0, 1.5, 0]}>
            <Text3D
                ref={meshRef}
                font={fontUrl}
                size={0.8}
                height={0.1}
                curveSegments={12}
                bevelEnabled
                bevelThickness={0.02}
                bevelSize={0.01}
                bevelOffset={0}
                bevelSegments={3}
            >
                SUMMER BREEZE
                {/* Invisible main mesh body */}
                <meshBasicMaterial visible={false} />
            </Text3D>
            {geo && <FrontFaceEdges geometry={geo} />}
        </Center>
    );
}
