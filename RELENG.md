# Releasing EM•Builder

EM•Builder is developed on the `dev` branch and published manually to the Visual Studio Marketplace.

The version in `package.json` is the release version and is the source of truth.

## Release steps

1. Update the version in `package.json`.

    Example:

    ```json
    "version": "26.1.0"
    ```

2. Commit and push the release-ready source on `dev`.

3. Build the VSIX package:

    ```bash
    npm run release-pack
    ```

    This produces a timestamped `.vsix` file.

4. Upload the generated `.vsix` manually to the Visual Studio Marketplace.

5. Wait for Marketplace acceptance.

6. After acceptance, tag the exact released commit:

    ```bash
    npm run release-tag
    ```

    For version `26.1.0`, this creates:

    ```text
    v26.1.0
    ```

7. Push the tag:

    ```bash
    git push origin v26.1.0
    ```

## Branch policy

- `dev` is the active development branch.
- Normal development occurs directly on `dev` or through contributor pull requests targeting `dev`.
- `main` is currently unused for normal development or releases.
- Marketplace releases are identified by Git tags on `dev`.

## Versioning

EM•Builder uses semantic-style versions:

```text
YY.minor.patch
```

The major version broadly tracks the EM•Script generation/year.

Minor and patch versions evolve independently from EM•porium and EM•Script.

Every Marketplace publication must use a new version.
