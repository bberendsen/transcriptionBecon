/** @type {import('next').NextConfig} */
const nextConfig = {
  // Enable serverless functions
  experimental: {
    serverActions: false,
  },
  // Ensure proper Node.js version
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'canvas', 'jsdom'];
    }
    return config;
  },
};

export default nextConfig;

