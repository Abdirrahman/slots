# Blender game-asset pipeline

Use Blender Python and bpy. Do not require third-party Blender add-ons.

## Visual style

- Stylized toy-like objects
- Low-poly geometry
- Rounded bevelled edges
- Simple, bright materials
- Large readable shapes
- Consistent scale across the asset set

## Technical requirements

- Generate assets deterministically from Python
- Scripts must work from a clean Blender startup
- Apply object scale before export
- Put the object origin at ground level and centered horizontally
- Use clear object and material names
- Use Principled BSDF materials compatible with glTF
- Export each asset as GLB
- Save the source scene as a BLEND file
- Render a 512x512 transparent card image
- Avoid unnecessary geometry and textures

## Validation

Check dimensions, triangle count, transforms, missing materials and output files.
The build command must return a nonzero exit code when generation fails.
