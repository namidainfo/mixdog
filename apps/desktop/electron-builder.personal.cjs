module.exports = {
  extends: './electron-builder.yml',
  appId: 'io.namidainfo.mixdog.personal',
  productName: 'Mixdog Personal',
  executableName: 'Mixdog Personal',
  extraMetadata: { name: 'mixdog-personal', version: '1.2.4-personal.1' },
  artifactName: 'mixdog-personal-${version}-${os}-${arch}.${ext}',
  protocols: [{ name: 'Mixdog Personal', schemes: ['mixdog-personal'] }],
  directories: { output: 'dist-personal' },
  nsis: { useZip: true, differentialPackage: false },
  publish: null,
};
