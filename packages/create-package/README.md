# `create-package`

> [!NOTE]
> Originally adapted from
> [`MetaMask/core#85188d8`](https://github.com/MetaMask/core/tree/85188d8146d13f06e1fe1a4143b6a35ac95630ea/scripts/create-package).

Manually creating a new monorepo package can be a tedious, even frustrating process. To alleviate that
problem, we have created this CLI that automates most of the job for us, creatively titled
`create-package`. To create a new monorepo package, follow these steps:

1. Create a new package using `yarn create-package`.
   - Use the `--help` flag for usage information.
   - Once this is done, you can find a package with your chosen name in `/packages`.
   - By default, `create-package` does not set a license. We intend to change this behavior
2. Add your dependencies.
   - Do this as normal using `yarn`.
   - Remember, if you are adding other monorepo packages as dependents, don't forget to add them
     to the `references` array in your package's `tsconfig.build.json`.
3. Add coverage thresholds to the root `vitest.config.ts` file.
   - The downside of `.ts` config files is that they suck to work with programmatically.

And that's it!

## Contributing to `create-package`

Along with this documentation, `create-package` is intended to be the source of truth for the process of adding new packages to the monorepo. Consequently, to change that process, you will want to change `create-package`.

The `create-package` references a [template package](../template-package/). This is an actual private package located at `packages/template-package`. The CLI is not aware of the contents of the template, only that its files have [placeholder values](./src/constants.ts). When a new package is created, the template files are read from disk, the placeholder values are replaced with real ones, and the updated files are added to a new directory in `/packages`. To modify the template package:

- If you need to add or modify any files or folders, just go ahead and make your changes in [`/packages/template-package`](../template-package/). The CLI will read whatever's in that directory and write it to disk.
- If you need to add or modify any placeholders, make sure that your desired values are added to both the relevant file(s) and [`./src/constants.ts`](./src/constants.ts). Then, update the implementation of the CLI accordingly.
- As with placeholders, updating the monorepo files that the CLI interacts with begins by updating [`./src/constants.ts`](./src/constants.ts).
