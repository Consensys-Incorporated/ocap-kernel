## Setup Local Tests

### Install Ollama

1. Visit [https://ollama.ai](https://ollama.ai) and download Ollama for your platform
2. Install and start the Ollama service
3. Verify installation:

   ```bash
   curl http://localhost:11434
   ```

   You should see: `Ollama is running`

### Download Required Models

The tests require the following model:

- `llama3.1:latest`

Download the model:

```bash
ollama pull llama3.1:latest
```

Verify the model is available:

```bash
ollama list
```

You should see `llama3.1:latest` in the output.

To run the tests against another ollama model, such as `flint:latest`, pull it and set
`LMS_MODEL`:

```bash
ollama pull flint:latest
LMS_MODEL='flint:latest' yarn test:e2e:local
```

### Validate Test Framework Setup

Verify the configured test framework can access the resources above.

```bash
yarn test:e2e:local -t suite
```

All suite tests should pass, with all other tests skipped.
