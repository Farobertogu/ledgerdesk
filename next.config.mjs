// Next.js configuration for the three consoles.
//
// tsconfigPath points at a configuration of the application's own: the tsconfig.json at the root
// belongs to the quality layer (NodeNext, no JSX) and typechecking both trees from one file would
// mean loosening the settings of a tree that does not need loosening.

/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { tsconfigPath: './tsconfig.app.json' },
};

export default nextConfig;
