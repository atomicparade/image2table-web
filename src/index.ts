/* eslint max-classes-per-file: 0 */

import {
  Bbox, createScheduler, createWorker, Page, RecognizeResult, Scheduler,
} from 'tesseract.js';

import IntRange from './intrange';
import IntRangeSet from './intrangeset';

const NUM_WORKERS = 3; // This many images can be processed simultneously

const DEFAULTS = {
  SCALE: 3, // Higher scale leads to better accuracy, but longer processing time
  COLUMN_THRESHOLD: 5, // Maximum number of pixels distance to form a continuous column
  CONFIDENCE_THRESHOLD: 90,
  LOW_CONFIDENCE_MARKER: ' (?)',
};

type MessageType =
  | 'info'
  | 'error'
;

type Row = string[];

type Table = Row[];

interface ProcessingOptions {
  scale: number;
  delimiter: string;
  columnThreshold: number;
  confidenceThreshold: number;
  lowConfidenceMarker: string;
}

interface OcrProcessingResult {
  table: Table;
  lowConfidenceBoxes: Bbox[];
}

function isType<T>(value: any): value is T {
  return (value as T) !== undefined;
}

class MessageContainer {
  readonly el: HTMLElement;

  constructor(initialMessage?: string, initialMessageType?: MessageType) {
    this.setMessage = this.setMessage.bind(this);

    this.el = document.createElement('p');
    this.el.className = 'message';

    if (initialMessage !== undefined) {
      this.setMessage(initialMessage, initialMessageType);
    }
  }

  setMessage(message: string, messageType: MessageType = 'info') {
    while (this.el.firstChild) {
      this.el.removeChild(this.el.firstChild);
    }

    this.el.classList.remove('info');
    this.el.classList.remove('error');
    this.el.classList.add(messageType);
    this.el.appendChild(document.createTextNode(message));
  }
}

function readFileAsDataURL(file: File): Promise<string> {
  const fileReader = new FileReader();

  const promise = new Promise<string>((resolve, reject) => {
    fileReader.onload = (event) => {
      if (event.target === null || typeof (event.target.result) !== 'string') {
        reject(Error('Unable to load file as data URL'));
        return;
      }

      resolve(event.target.result);
    };
  });

  fileReader.readAsDataURL(file);

  return promise;
}

async function scaleImage(image: string, scale: number): Promise<string> {
  const img = document.createElement('img');

  await new Promise<void>((resolve) => {
    img.onload = () => {
      resolve();
    };

    img.src = image;
  });

  const newWidth = img.width * scale;
  const newHeight = img.height * scale;

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  canvas.width = newWidth;
  canvas.height = newHeight;

  if (!context) {
    throw new Error('Unable to retrieve canvas context');
  }

  context.drawImage(img, 0, 0, newWidth, newHeight);

  return canvas.toDataURL();
}

function processOcrData(page: Page, processingOptions: ProcessingOptions): OcrProcessingResult {
  const table: Table = [];
  const lowConfidenceBoxes: Bbox[] = [];

  const columnRanges: IntRange[] = [];

  const {
    scale,
    columnThreshold,
    confidenceThreshold,
    lowConfidenceMarker,
  } = processingOptions;

  // Determine column positions based on column threshold
  for (let i = 0, iN = page.symbols.length; i < iN; i += 1) {
    const symbol = page.symbols[i];
    columnRanges.push({ start: symbol.bbox.x0, end: symbol.bbox.x1 });
  }

  const columnRangeSet = new IntRangeSet(columnRanges, columnThreshold * scale);

  // Determine cell contents based on column positions
  for (let i = 0, iN = page.lines.length; i < iN; i += 1) {
    const line = page.lines[i];

    const row: Row = [];
    let cellContents: string | null = null;
    let cellConfidence = 100;
    let currentColumn: number | null = null;

    for (let j = 0, jN = line.words.length; j < jN; j += 1) {
      const word = line.words[j];

      if (word.confidence < confidenceThreshold) {
        lowConfidenceBoxes.push({
          x0: word.bbox.x0 / scale,
          y0: word.bbox.y0 / scale,
          x1: word.bbox.x1 / scale,
          y1: word.bbox.y1 / scale,
        });
      }

      const thisWordColumn = columnRangeSet.getIndex(word.bbox.x0);

      if (thisWordColumn === currentColumn) {
        cellConfidence = Math.min(cellConfidence, word.confidence);

        if (cellContents === null) {
          cellContents = word.text;
        } else {
          cellContents = `${cellContents} ${word.text}`;
        }
      } else {
        if (cellContents !== null) {
          if (cellConfidence < confidenceThreshold) {
            cellContents = `${cellContents}${lowConfidenceMarker}`;
          }

          row.push(cellContents);
        }

        if (currentColumn === null) {
          currentColumn = 0;
        }

        // thisWordColumn should never be null, because all symbols' bbox.x0s
        // are added to columnRangeSet
        if (thisWordColumn !== null) {
          // Add blank cells for skipped columns
          for (let k = (thisWordColumn - currentColumn) - 1; k > 0; k -= 1) {
            row.push('');
          }
        }

        // Begin a new cell
        cellContents = word.text;
        cellConfidence = word.confidence;
        currentColumn = thisWordColumn;
      }
    }

    // Add the contents of the last cell to the row
    if (cellContents !== null) {
      if (cellConfidence < confidenceThreshold) {
        cellContents = `${cellContents}${lowConfidenceMarker}`;
      }

      row.push(cellContents);
    }

    table.push(row);
  }

  return { table, lowConfidenceBoxes };
}

async function markBoxes(image: string, boxes: Bbox[]): Promise<string> {
  const img = document.createElement('img');

  await new Promise((resolve) => {
    img.onload = resolve;
    img.src = image;
  });

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  if (!context) {
    throw new Error('Unable to retrieve canvas context');
  }

  canvas.width = img.width;
  canvas.height = img.height;

  context.drawImage(img, 0, 0);

  context.strokeStyle = '#ff0000';
  context.lineWidth = 2;

  for (let i = 0, iN = boxes.length; i < iN; i += 1) {
    const box = boxes[i];
    const x = box.x0;
    const y = box.y0;
    const width = box.x1 - x;
    const height = box.y1 - y;
    context.strokeRect(x - 2, y - 2, width + 4, height + 4);
  }

  return canvas.toDataURL();
}

class AppRequest {
  readonly el: HTMLElement;

  readonly elImg: HTMLImageElement;

  readonly elTextarea: HTMLTextAreaElement;

  readonly messageContainer: MessageContainer;

  constructor(appRequestContainer: HTMLElement) {
    this.el = document.createElement('section');
    appRequestContainer.insertBefore(this.el, appRequestContainer.firstChild);

    this.messageContainer = new MessageContainer('Loading...please wait.');
    this.el.appendChild(this.messageContainer.el);

    this.elTextarea = document.createElement('textarea');
    this.el.appendChild(this.elTextarea);
    this.elTextarea.classList.add('hidden');

    const pImg = document.createElement('p');
    pImg.className = 'image';

    this.elImg = document.createElement('img');

    pImg.appendChild(this.elImg);
    this.el.appendChild(pImg);
  }

  async start(
    scheduler: Scheduler,
    image: string,
    processingOptions: ProcessingOptions,
  ): Promise<void> {
    this.elImg.src = image;

    this.elTextarea.classList.add('hidden');

    const { scale, delimiter } = processingOptions;

    const startTime = new Date();

    this.messageContainer.setMessage('Resizing image to improve accuracy...please wait.');
    const scaledImage = await scaleImage(image, scale);

    this.messageContainer.setMessage('Converting image to text...please wait.');
    const result = await scheduler.addJob('recognize', scaledImage);
    if (!isType<RecognizeResult>(result)) {
      throw new Error('Tesseract did not return a RecognizeResult');
    }
    const { data } = result;

    this.messageContainer.setMessage('Processing data in image...please wait.');
    const { table, lowConfidenceBoxes } = processOcrData(
      data,
      processingOptions,
    );

    const endTime = new Date();
    const jobDurationSeconds = (endTime.getTime() - startTime.getTime()) / 1000;
    const jobDurationSecondsStr = jobDurationSeconds.toLocaleString(
      undefined, // Use default locale
      { maximumFractionDigits: 2, minimumFractionDigits: 2 },
    );

    this.messageContainer.setMessage(`Image processing completed in ${jobDurationSecondsStr} seconds.`);

    this.elTextarea.classList.remove('hidden');

    let text = '';

    let lengthOfLongestWord = 1;

    for (let i = 0, iN = table.length; i < iN; i += 1) {
      const row = table[i];

      for (let j = 0, jN = row.length; j < jN; j += 1) {
        const cell = row[j];

        lengthOfLongestWord = Math.max(cell.length, lengthOfLongestWord);

        text = `${text}${cell}${delimiter}`;
      }

      // Remove the last delimiter
      if (row.length >= 1) {
        text = text.slice(0, -1);
      }

      text = `${text}\n`;
    }

    this.elTextarea.setAttribute('style', `tab-size: ${lengthOfLongestWord + 2}`);
    this.elTextarea.value = text;

    // Mark words with low confidence on the image
    const markedImage = await markBoxes(image, lowConfidenceBoxes);
    this.elImg.src = markedImage;
  }
}

function getProcessingOptions(): ProcessingOptions {
  const inputScale = document.getElementById('scale');
  const btnTab = document.getElementById('btnTab');
  const inputColumnThreshold = document.getElementById('columnThreshold');
  const inputConfidenceThreshold = document.getElementById('confidenceThreshold');
  const inputLowConfidenceMarker = document.getElementById('lowConfidenceMarker');

  if (!isType<HTMLInputElement>(inputScale)) {
    throw new Error('Unable to obtain #inputScale');
  }

  if (!isType<HTMLInputElement>(btnTab)) {
    throw new Error('Unable to obtain #btnTab');
  }

  if (!isType<HTMLInputElement>(inputColumnThreshold)) {
    throw new Error('Unable to obtain #inputColumnThreshold');
  }

  if (!isType<HTMLInputElement>(inputConfidenceThreshold)) {
    throw new Error('Unable to obtain #inputConfidenceThreshold');
  }

  if (!isType<HTMLInputElement>(inputLowConfidenceMarker)) {
    throw new Error('Unable to obtain #inputLowConfidenceMarker');
  }

  const scale = Number.parseInt(inputScale.value, 10);
  const delimiter = btnTab.checked ? '\t' : ',';
  const columnThreshold = Number.parseInt(inputColumnThreshold.value, 10);
  const confidenceThreshold = Number.parseInt(inputConfidenceThreshold.value, 10);
  const lowConfidenceMarker = inputLowConfidenceMarker.value;

  return {
    scale, delimiter, columnThreshold, confidenceThreshold, lowConfidenceMarker,
  };
}

async function createAppRequest(
  scheduler: Scheduler,
  file: File,
  processingOptions: ProcessingOptions,
): Promise<void> {
  const appRequestContainer = document.getElementById('appRequestContainer');

  if (!appRequestContainer) {
    throw new Error('Unable to obtain #appRequestContainer');
  }

  const image = await readFileAsDataURL(file);

  const appRequest = new AppRequest(appRequestContainer);
  await appRequest.start(scheduler, image, processingOptions);
}

async function handlePaste(event: ClipboardEvent, scheduler: Scheduler): Promise<void> {
  if (event.clipboardData === null) {
    return;
  }

  const { items } = event.clipboardData;

  const promises: Promise<void>[] = [];

  const processingOptions = getProcessingOptions();

  for (let i = 0, iN = items.length; i < iN; i += 1) {
    const item = items[i];

    if (item.kind === 'file') {
      const file = item.getAsFile();

      if (file instanceof File) {
        promises.push(createAppRequest(scheduler, file, processingOptions));
      }
    }
  }

  await Promise.all(promises);
}

async function addWorker(scheduler: Scheduler): Promise<void> {
  const worker = createWorker();

  await worker.load();
  await worker.loadLanguage('eng');
  await worker.initialize('eng');

  scheduler.addWorker(worker);
}

function createOptionsForm(): HTMLFormElement {
  const form = document.createElement('form');
  let p;

  {
    p = document.createElement('p');
    form.appendChild(p);

    const lblScale = document.createElement('label');
    p.appendChild(lblScale);
    lblScale.htmlFor = 'scale';
    lblScale.classList.add('range');
    lblScale.appendChild(document.createTextNode('Scale'));
    const inputScale = document.createElement('input');
    p.appendChild(document.createTextNode('1'));
    p.appendChild(inputScale);
    p.appendChild(document.createTextNode('10'));
    inputScale.id = 'scale';
    inputScale.type = 'range';
    inputScale.value = DEFAULTS.SCALE.toString();
    inputScale.min = '1';
    inputScale.max = '10';
    inputScale.step = '1';
  }

  {
    p = document.createElement('p');
    form.appendChild(p);

    const lblColumnThreshold = document.createElement('label');
    p.appendChild(lblColumnThreshold);
    lblColumnThreshold.htmlFor = 'columnThreshold';
    lblColumnThreshold.classList.add('range');
    lblColumnThreshold.appendChild(document.createTextNode('Column threshold'));
    const inputColumnThreshold = document.createElement('input');
    p.appendChild(document.createTextNode('1'));
    p.appendChild(inputColumnThreshold);
    p.appendChild(document.createTextNode('100'));
    inputColumnThreshold.id = 'columnThreshold';
    inputColumnThreshold.type = 'range';
    inputColumnThreshold.value = DEFAULTS.COLUMN_THRESHOLD.toString();
    inputColumnThreshold.min = '0';
    inputColumnThreshold.max = '100';
    inputColumnThreshold.step = '1';

    const lblDelimiter = document.createElement('label');
    p.appendChild(lblDelimiter);
    lblDelimiter.appendChild(document.createTextNode('Column Delimiter'));

    const btnTab = document.createElement('input');
    p.appendChild(btnTab);
    btnTab.id = 'btnTab';
    btnTab.type = 'radio';
    btnTab.name = 'delimiter';
    btnTab.value = 'tab';
    btnTab.checked = true;
    const lblTab = document.createElement('label');
    p.appendChild(lblTab);
    lblTab.classList.add('radio');
    lblTab.htmlFor = 'btnTab';
    lblTab.appendChild(document.createTextNode('Tab'));

    const btnComma = document.createElement('input');
    p.appendChild(btnComma);
    btnComma.id = 'btnComma';
    btnComma.type = 'radio';
    btnComma.name = 'delimiter';
    btnComma.value = 'comma';
    const lblComma = document.createElement('label');
    p.appendChild(lblComma);
    lblComma.classList.add('radio');
    lblComma.htmlFor = 'btnComma';
    lblComma.appendChild(document.createTextNode('Comma'));
  }

  {
    p = document.createElement('p');
    form.appendChild(p);

    const lblConfidenceThreshold = document.createElement('label');
    p.appendChild(lblConfidenceThreshold);
    lblConfidenceThreshold.htmlFor = 'confidenceThreshold';
    lblConfidenceThreshold.classList.add('range');
    lblConfidenceThreshold.appendChild(document.createTextNode('Confidence threshold'));
    const inputConfidenceThreshold = document.createElement('input');
    p.appendChild(document.createTextNode('1'));
    p.appendChild(inputConfidenceThreshold);
    p.appendChild(document.createTextNode('100'));
    inputConfidenceThreshold.id = 'confidenceThreshold';
    inputConfidenceThreshold.type = 'range';
    inputConfidenceThreshold.value = DEFAULTS.CONFIDENCE_THRESHOLD.toString();
    inputConfidenceThreshold.min = '0';
    inputConfidenceThreshold.max = '100';
    inputConfidenceThreshold.step = '1';

    const lblLowConfidenceMarker = document.createElement('label');
    p.appendChild(lblLowConfidenceMarker);
    lblLowConfidenceMarker.htmlFor = 'lowConfidenceMarker';
    lblLowConfidenceMarker.appendChild(document.createTextNode('Low confidence marker'));
    const inputLowConfidenceMarker = document.createElement('input');
    p.appendChild(inputLowConfidenceMarker);
    inputLowConfidenceMarker.id = 'lowConfidenceMarker';
    inputLowConfidenceMarker.type = 'text';
    inputLowConfidenceMarker.value = DEFAULTS.LOW_CONFIDENCE_MARKER;
  }

  return form;
}

async function init(): Promise<void> {
  const appMessageContainer = new MessageContainer('Loading...please wait.');
  const appRequestContainer = document.createElement('main');
  appRequestContainer.id = 'appRequestContainer';

  document.body.appendChild(createOptionsForm());
  document.body.appendChild(appMessageContainer.el);
  document.body.appendChild(appRequestContainer);

  const scheduler = createScheduler();

  const workerPromises: Promise<void>[] = [];

  for (let i = 0; i < NUM_WORKERS; i += 1) {
    workerPromises.push((async (): Promise<void> => {
      await addWorker(scheduler);
    })());
  }

  await Promise.all(workerPromises);

  document.addEventListener('paste', async (event: ClipboardEvent): Promise<void> => {
    await handlePaste(event, scheduler);
  });

  appMessageContainer.setMessage('Please paste an image.');
}

window.addEventListener('load', init);
