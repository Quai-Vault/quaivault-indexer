import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // TypeScript-specific rules
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // General code quality
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always'],

      // Async/Promise rules
      'no-return-await': 'error',
      'require-await': 'off', // TypeScript handles this better

      // Security-related
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '*.js', '!eslint.config.js'],
  }
);
