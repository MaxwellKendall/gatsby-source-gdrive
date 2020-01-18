const { google } = require('googleapis');
const path = require(`path`);
const mkdirp = require(`mkdirp`);
const fs = require(`fs`);
const lodash = require('lodash')

const log = str => console.log(`\n🚗 `, str);
const FOLDER = `application/vnd.google-apps.folder`;
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const exportMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const defaultOptions = {
    folderId: '16donbs7-81ncyDK2G4XFI9b5Cf_I0GDD',
    key: '',
    scopes: [
      'https://www.googleapis.com/auth/drive',
    ]
};

const getFolder = async (gDriveClient, folderId) => {
    const { data: { files }} = await gDriveClient.files.list({ q: `'${folderId}' in parents`});
    return files;
};

const getAuthorziedGdriveClient = (options) => {
  let key;
  const { scopes } = options;

  if (options.key) key = JSON.parse(options.key);
  if (fs.existsSync(options.pemFilePath)) {
      key = require(options.pemFilePath);
  }
    // setting the general auth property for client
    const token = new google.auth.JWT(
      key.client_email,
      null,
      key.private_key,
      scopes
  );
  google.options({ auth: token });

  return google.drive('v3');
};

exports.onPreBootstrap = (
  { graphql, actions },
  options
) => {
  return new Promise(async (resolve) => {
    log(`Started downloading content...`);

    // Get token and fetch root folder.
    const { folderId, destination } = options;

    // getting the drive client
    const gDriveClient = getAuthorziedGdriveClient(options);
    const filesInFolder = await getFolder(gDriveClient, folderId);

    // Create content directory if it doesn't exist.
    mkdirp(destination);

    // Start downloading recursively through all folders.
    console.time(`Downloading content ⏲`);

    Promise.all(fetchFilesInFolder(filesInFolder, undefined, gDriveClient, destination))
      .then(() => {
        resolve();
        log(`Downloaded all files from Google Drive! 🍻`);
        console.timeEnd(`Downloading content ⏲`);
      });
  });
};

function fetchFilesInFolder(filesInFolder, parent = '', gDriveClient, destination, write = true) {
    const promises = [];

    filesInFolder.forEach(async (file) => {
      if (file.mimeType === FOLDER) {
        // If it`s a folder, create it in filesystem
        const snakeCasedFolderName = file.name.toLowerCase().split(' ').join('_');
        if (write) {
            log(`Creating folder ${parent}/${snakeCasedFolderName}`);
            mkdirp(path.join(destination, parent, snakeCasedFolderName));
        }

        // Then, get the files inside and run the function again.
        const nestedFiles = getFolder(gDriveClient, file.id)
          .then((files) => {
            // combining array of promises into one.
            return Promise.all(fetchFilesInFolder(files, `${parent}/${snakeCasedFolderName}`, gDriveClient, destination, write));
          });
        promises.push(nestedFiles);
      }
      else {
        promises.push(
          new Promise(async (resolve, reject) => {
            if (write) {
                // If it`s a file, download it and convert to buffer.
                const filePath = path.join(destination, parent, getFilenameByMime(file));
                const driveResponse = await gDriveClient.files.get({ fileId: file.id, alt: 'media', fields: "*" }, { responseType: 'arraybuffer' });
                const buff = new Buffer.from(driveResponse.data);
                fs.writeFile(filePath, buff, () => {
                    log(`${file.name} written`);
                    return resolve(getFilenameByMime(file));
                });
            }
            else {
                const { data } = await gDriveClient.files.get({ fileId: file.id, fields: "description, name, kind, modifiedTime, trashed, id" });
                resolve(data);
            }
        }));
      }
    });

    return promises;
}

const fileExtensionsByMime = new Map([
  ['text/html', '.html'],
  ['application/zip', '.zip'],
  ['text/plain', '.txt'],
  ['application/rtf', '.rtf'],
  ['application/vnd.oasis.opendocument.text', '.odt'],
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/epub+zip', '.epub']
]);

const getFilenameByMime = file => {
  if (file.mimeType === GOOGLE_DOC) {
    return `${file.name}${fileExtensionsByMime.get(exportMime)}`
  } else {
    return file.name;
  }
}

exports.sourceNodes = async ({ actions }, options) => {
    log('creating graphql nodes...', options);
    const { createNode } = actions;
    const { folderId } = options;
    const gDriveClient = getAuthorziedGdriveClient(options);
    let filesInFolder;

    try {
      filesInFolder = await getFolder(gDriveClient, folderId);
    }
    catch(e) {
      console.log(`some stupid error... ${e}`);
    }
  
    Promise.all(fetchFilesInFolder(filesInFolder, undefined, gDriveClient, '', false))
      .then((allFiles) => {
        lodash.flattenDeep(allFiles)
            .filter((file) => !file.trashed)
            .map((file) => ({
                id: file.id,
                description: file.description ? file.description : '',
                name: file.name,
                internal: {
                    contentDigest: `${file.id}_${file.modifiedTime}`,
                    type: 'gDriveContent'
                }
            }))
            .forEach((file) => createNode(file))
      })
      .catch(e => console.log(`Error: ${e}`));

      // we're done, return.
      return;
};