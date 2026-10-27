# `@metamask/kernel-language-model-service`

A package providing language model service implementations for the ocap kernel. This package defines interfaces and implementations for integrating various language model providers (like Ollama) into the kernel's object capability system.

## Installation

`yarn add @metamask/kernel-language-model-service`

or

`npm install @metamask/kernel-language-model-service`

## Overview

This package provides:

- **Generic interfaces** for language model services that can be implemented by different providers
- **Ollama integration** for local language model inference
- **Object capability security** through hardened instances and endowment patterns
- **Type-safe configuration** using Superstruct validation

## Architecture

The package follows the object capability pattern with clear separation of concerns:

- `LanguageModelService` - Factory interface for creating model instances
- `LanguageModel` - Interface for individual model instances
- Provider-specific implementations (e.g., `OllamaNodejsService`)

All model instances are hardened using `harden()` from `@endo/ses` for security.

## Usage

### Basic Ollama Integration

```typescript
import { OllamaNodejsService } from '@metamask/kernel-language-model-service/ollama/nodejs';

// Create a service instance with required endowments
const service = new OllamaNodejsService({
  endowments: { fetch: global.fetch },
});

// Create a model instance
const model = await service.makeInstance({
  model: 'llama2',
  options: { temperature: 0.7 },
});

// (Optional) Load the model into memory
await model.load();

// Generate a response
const response = await model.sample('Hello, world!');
for await (const chunk of response) {
  console.log(chunk.response);
}

// (Optional) Unload the model when done
await model.unload();
```

### Listing Available Models

```typescript
const models = await service.getModels();
console.log(
  'Available models:',
  models.models.map((m) => m.name),
);
```

## Security Considerations

- **Object Capabilities**: All model instances are hardened and can be safely passed between vats
- **Endowment Pattern**: External dependencies (like `fetch`) must be explicitly provided
- **Validation**: All configurations are validated using Superstruct schemas

## API Reference

### Core Types

- `LanguageModelService<Config, Options, Response>` - Factory for creating model instances
- `LanguageModel<Options, Response>` - Interface for model instances
- `ModelInfo<Options>` - Configuration information for a model
- `InstanceConfig<Options>` - Configuration for creating model instances

### Ollama Types

- `OllamaNodejsService` - Node.js implementation of Ollama service
- `OllamaModelOptions` - Valid options for Ollama model generation
- `OllamaInstanceConfig` - Configuration for Ollama model instances

## Contributing

This package is part of a monorepo. Instructions for contributing can be found in the [monorepo README](https://github.com/Consensys-Incorporated/ocap-kernel#readme).
