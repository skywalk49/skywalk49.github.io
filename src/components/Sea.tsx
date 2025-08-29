import * as THREE from 'three'
import React, { Suspense, useRef, useMemo } from 'react'
import { Canvas, extend, useThree, useLoader, useFrame } from '@react-three/fiber'
import { OrbitControls, Sky } from '@react-three/drei'
import { Water } from 'three-stdlib'
extend({ Water })

declare global {
    namespace JSX {
        interface IntrinsicElements {
            water: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
                args?: any
                ref?: React.Ref<any>
                ['rotation-x']?: number
            }
        }
    }
}

const Ocean = () => {
    const ref = useRef<THREE.Mesh | any>(null)
    const gl = useThree((state) => state.gl) as any
    const waterNormals = useLoader(THREE.TextureLoader, '/waternormals.jpeg')
    waterNormals.wrapS = waterNormals.wrapT = THREE.RepeatWrapping
    const geom = useMemo(() => new THREE.PlaneGeometry(10000, 10000), [])
    const config = useMemo(
        () => ({
            textureWidth: 512,
            textureHeight: 512,
            waterNormals,
            sunDirection: new THREE.Vector3(),
            sunColor: 0xffffff,
            waterColor: 0x001e0f,
            distortionScale: 3.7,
            fog: false,
            format: gl.encoding
        }),
        [waterNormals]
    )
    useFrame((_state, delta) => (ref.current.material.uniforms.time.value += delta))
    return <primitive ref={ref} object={new Water(geom, config)} rotation-x={-Math.PI / 2} />
}

const Sea = () => {
    return (
        <Canvas camera={{ position: [0, 5, 100], fov: 55, near: 1, far: 20000 }}>
            <pointLight decay={0} position={[100, 100, 100]} />
            <pointLight decay={0.5} position={[-100, -100, -100]} />
            <Suspense fallback={null}>
                <Ocean />
            </Suspense>
            <Sky sunPosition={[500, 150, -1000]} turbidity={0.1} />
            <OrbitControls />
        </Canvas>
    )
}

export default Sea