/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  'rgb(var(--brand-50) / <alpha-value>)',
          100: 'rgb(var(--brand-100) / <alpha-value>)',
          200: 'rgb(var(--brand-200) / <alpha-value>)',
          300: 'rgb(var(--brand-300) / <alpha-value>)',
          400: 'rgb(var(--brand-400) / <alpha-value>)',
          500: 'rgb(var(--brand-500) / <alpha-value>)',
          600: 'rgb(var(--brand-600) / <alpha-value>)',
          700: 'rgb(var(--brand-700) / <alpha-value>)',
          800: 'rgb(var(--brand-800) / <alpha-value>)',
          900: 'rgb(var(--brand-900) / <alpha-value>)',
        },
        surface: {
          50:  'rgb(var(--surface-50) / <alpha-value>)',
          100: 'rgb(var(--surface-100) / <alpha-value>)',
          200: 'rgb(var(--surface-200) / <alpha-value>)',
          300: 'rgb(var(--surface-300) / <alpha-value>)',
          400: 'rgb(var(--surface-400) / <alpha-value>)',
          500: 'rgb(var(--surface-500) / <alpha-value>)',
          600: 'rgb(var(--surface-600) / <alpha-value>)',
          700: 'rgb(var(--surface-700) / <alpha-value>)',
          750: 'rgb(var(--surface-750) / <alpha-value>)',
          800: 'rgb(var(--surface-800) / <alpha-value>)',
          900: 'rgb(var(--surface-900) / <alpha-value>)',
        },
        // Tokens V2 (--vc-*). Consumo directo: bg-vc-surface, text-vc-primary, etc.
        // El motor los emite como hex, por eso sin sintaxis /<alpha-value>.
        vc: {
          background: 'var(--vc-background)',
          surface: 'var(--vc-surface)',
          'surface-raised': 'var(--vc-surface-raised)',
          'surface-overlay': 'var(--vc-surface-overlay)',
          border: 'var(--vc-border)',
          'border-strong': 'var(--vc-border-strong)',
          'text-primary': 'var(--vc-text-primary)',
          'text-secondary': 'var(--vc-text-secondary)',
          'text-muted': 'var(--vc-text-muted)',
          primary: 'var(--vc-primary)',
          accent: 'var(--vc-accent)',
          success: 'var(--vc-success)',
          warning: 'var(--vc-warning)',
          danger: 'var(--vc-danger)',
          information: 'var(--vc-information)',
          offline: 'var(--vc-offline)',
          recording: 'var(--vc-recording)',
          analytics: 'var(--vc-analytics)',
        },
      },
      borderRadius: {
        vc: 'var(--vc-radius)',
      },
      width: {
        'vc-sidebar': 'var(--vc-sidebar-width)',
      },
      height: {
        vc: 'var(--vc-component-height)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'fade-in': 'fadeIn 0.2s ease-in',
        'slide-in': 'slideIn 0.2s ease-out',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: 0 }, '100%': { opacity: 1 } },
        slideIn: { '0%': { transform: 'translateY(-8px)', opacity: 0 }, '100%': { transform: 'translateY(0)', opacity: 1 } },
      },
    },
  },
  plugins: [],
}
