use core::cell::RefCell;
use core::ops::Bound;
use std::collections::BTreeMap;
use std::io;

use redb::{
    Database, Durability, ReadOnlyDatabase, ReadTransaction, ReadableDatabase, ReadableTable,
    StorageBackend, TableDefinition, TableError, TableHandle, WriteTransaction,
};

// ---------------------------------------------------------------------------
// Host StorageBackend imports (provided by Browser OPFS, Node.js fs, or RAM)
// ---------------------------------------------------------------------------

#[link(wasm_import_module = "env")]
extern "C" {
    fn host_read(handle: u32, offset: f64, dst_ptr: *mut u8, dst_len: u32) -> i32;
    fn host_write(handle: u32, offset: f64, src_ptr: *const u8, src_len: u32) -> i32;
    fn host_len(handle: u32) -> f64;
    fn host_set_len(handle: u32, new_len: f64) -> i32;
    fn host_sync(handle: u32) -> i32;
    fn host_close(handle: u32) -> i32;
}

#[derive(Debug)]
struct HostBackend {
    handle: u32,
}

// WASM without atomics/threads is single-threaded; StorageBackend requires Send + Sync.
unsafe impl Send for HostBackend {}
unsafe impl Sync for HostBackend {}

impl StorageBackend for HostBackend {
    fn len(&self) -> io::Result<u64> {
        let n = unsafe { host_len(self.handle) };
        if n < 0.0 || !n.is_finite() {
            return Err(io::Error::other("host_len failed"));
        }
        Ok(n as u64)
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        if out.is_empty() {
            return Ok(());
        }
        let n = unsafe {
            host_read(
                self.handle,
                offset as f64,
                out.as_mut_ptr(),
                out.len() as u32,
            )
        };
        if n < 0 {
            return Err(io::Error::other("host_read failed"));
        }
        if (n as usize) < out.len() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "host_read reached unexpected EOF",
            ));
        }
        Ok(())
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        let rc = unsafe { host_set_len(self.handle, len as f64) };
        if rc < 0 {
            return Err(io::Error::other("host_set_len failed"));
        }
        Ok(())
    }

    fn sync_data(&self) -> io::Result<()> {
        let rc = unsafe { host_sync(self.handle) };
        if rc < 0 {
            return Err(io::Error::other("host_sync failed"));
        }
        Ok(())
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let rc = unsafe {
            host_write(
                self.handle,
                offset as f64,
                data.as_ptr(),
                data.len() as u32,
            )
        };
        if rc < 0 {
            return Err(io::Error::other("host_write failed"));
        }
        Ok(())
    }

    fn close(&self) -> io::Result<()> {
        let rc = unsafe { host_close(self.handle) };
        if rc < 0 {
            return Err(io::Error::other("host_close failed"));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Global state (single-threaded WASM instance)
// ---------------------------------------------------------------------------

enum DbHandle {
    ReadWrite(Database),
    ReadOnly(ReadOnlyDatabase),
}

struct State {
    next_id: u32,
    dbs: BTreeMap<u32, DbHandle>,
    wtxs: BTreeMap<u32, WriteTransaction>,
    rtxs: BTreeMap<u32, ReadTransaction>,
    last_error: Vec<u8>,
    result_buf: Vec<u8>,
}

impl State {
    const fn new() -> Self {
        Self {
            next_id: 1,
            dbs: BTreeMap::new(),
            wtxs: BTreeMap::new(),
            rtxs: BTreeMap::new(),
            last_error: Vec::new(),
            result_buf: Vec::new(),
        }
    }

    fn alloc_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1).max(1);
        id
    }

    fn set_error(&mut self, msg: &str) {
        self.last_error.clear();
        self.last_error.extend_from_slice(msg.as_bytes());
    }
}

thread_local! {
    static STATE: RefCell<State> = const { RefCell::new(State::new()) };
}

fn run_i32(f: impl FnOnce(&mut State) -> Result<i32, String>) -> i32 {
    STATE.with(|cell| {
        let mut s = cell.borrow_mut();
        match f(&mut s) {
            Ok(v) => v,
            Err(e) => {
                s.set_error(&e);
                -1
            }
        }
    })
}

fn run_f64(f: impl FnOnce(&mut State) -> Result<f64, String>) -> f64 {
    STATE.with(|cell| {
        let mut s = cell.borrow_mut();
        match f(&mut s) {
            Ok(v) => v,
            Err(e) => {
                s.set_error(&e);
                -1.0
            }
        }
    })
}

unsafe fn slice_from_raw<'a>(ptr: *const u8, len: u32) -> &'a [u8] {
    if len == 0 || ptr.is_null() {
        &[]
    } else {
        core::slice::from_raw_parts(ptr, len as usize)
    }
}

unsafe fn str_from_raw<'a>(ptr: *const u8, len: u32) -> Result<&'a str, String> {
    core::str::from_utf8(slice_from_raw(ptr, len)).map_err(|_| "invalid UTF-8 string".to_string())
}

// ---------------------------------------------------------------------------
// Memory & error / result buffers
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn alloc(len: u32) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len as usize);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: u32) {
    if !ptr.is_null() && len > 0 {
        let _ = Vec::from_raw_parts(ptr, 0, len as usize);
    }
}

#[no_mangle]
pub extern "C" fn last_error_ptr() -> *const u8 {
    STATE.with(|cell| cell.borrow().last_error.as_ptr())
}

#[no_mangle]
pub extern "C" fn last_error_len() -> u32 {
    STATE.with(|cell| cell.borrow().last_error.len() as u32)
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    STATE.with(|cell| cell.borrow().result_buf.as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> u32 {
    STATE.with(|cell| cell.borrow().result_buf.len() as u32)
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn db_open(backend_handle: u32, cache_bytes: u32, read_only: u32) -> i32 {
    run_i32(|s| {
        let mut builder = Database::builder();
        if cache_bytes > 0 {
            builder.set_cache_size(cache_bytes as usize);
        }
        let backend = HostBackend {
            handle: backend_handle,
        };
        let entry = if read_only != 0 {
            DbHandle::ReadOnly(
                builder
                    .open_read_only_with_backend(backend)
                    .map_err(|e| e.to_string())?,
            )
        } else {
            DbHandle::ReadWrite(
                builder
                    .create_with_backend(backend)
                    .map_err(|e| e.to_string())?,
            )
        };
        let id = s.alloc_id();
        s.dbs.insert(id, entry);
        Ok(id as i32)
    })
}

#[no_mangle]
pub extern "C" fn db_close(db_id: u32) -> i32 {
    run_i32(|s| {
        let Some(db) = s.dbs.remove(&db_id) else {
            return Ok(0);
        };
        match db {
            DbHandle::ReadWrite(d) => d.close().map_err(|e| e.to_string())?,
            DbHandle::ReadOnly(d) => d.close().map_err(|e| e.to_string())?,
        }
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn db_compact(db_id: u32) -> i32 {
    run_i32(|s| {
        let Some(DbHandle::ReadWrite(db)) = s.dbs.get_mut(&db_id) else {
            return Err("invalid or read-only database handle".to_string());
        };
        let compacted = db.compact().map_err(|e| e.to_string())?;
        Ok(i32::from(compacted))
    })
}

#[no_mangle]
pub extern "C" fn db_check_integrity(db_id: u32) -> i32 {
    run_i32(|s| {
        let Some(DbHandle::ReadWrite(db)) = s.dbs.get_mut(&db_id) else {
            return Err("invalid or read-only database handle".to_string());
        };
        let ok = db.check_integrity().map_err(|e| e.to_string())?;
        Ok(i32::from(ok))
    })
}

// ---------------------------------------------------------------------------
// Scan helper
// ---------------------------------------------------------------------------

fn encode_scan_from_table<T: ReadableTable<&'static [u8], &'static [u8]>>(
    table: &T,
    start: Option<&[u8]>,
    end: Option<&[u8]>,
    reverse: bool,
    limit: u32,
    out: &mut Vec<u8>,
) -> Result<u32, String> {
    let start_bound = match start {
        Some(s) => Bound::Included(s),
        None => Bound::Unbounded,
    };
    let end_bound = match end {
        Some(e) => Bound::Excluded(e),
        None => Bound::Unbounded,
    };

    out.clear();
    out.extend_from_slice(&0u32.to_le_bytes());
    let mut count: u32 = 0;

    let range = table
        .range::<&[u8]>((start_bound, end_bound))
        .map_err(|e| e.to_string())?;

    if reverse {
        for item in range.rev() {
            let (k, v) = item.map_err(|e| e.to_string())?;
            let kb = k.value();
            let vb = v.value();
            out.extend_from_slice(&(kb.len() as u32).to_le_bytes());
            out.extend_from_slice(kb);
            out.extend_from_slice(&(vb.len() as u32).to_le_bytes());
            out.extend_from_slice(vb);
            count += 1;
            if limit > 0 && count >= limit {
                break;
            }
        }
    } else {
        for item in range {
            let (k, v) = item.map_err(|e| e.to_string())?;
            let kb = k.value();
            let vb = v.value();
            out.extend_from_slice(&(kb.len() as u32).to_le_bytes());
            out.extend_from_slice(kb);
            out.extend_from_slice(&(vb.len() as u32).to_le_bytes());
            out.extend_from_slice(vb);
            count += 1;
            if limit > 0 && count >= limit {
                break;
            }
        }
    }

    out[0..4].copy_from_slice(&count.to_le_bytes());
    Ok(count)
}

// ---------------------------------------------------------------------------
// Read transactions (MVCC snapshots)
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn rtx_begin(db_id: u32) -> i32 {
    run_i32(|s| {
        let tx = match s.dbs.get(&db_id) {
            Some(DbHandle::ReadWrite(db)) => db.begin_read(),
            Some(DbHandle::ReadOnly(db)) => db.begin_read(),
            None => return Err("invalid database handle".to_string()),
        }
        .map_err(|e| e.to_string())?;
        let id = s.alloc_id();
        s.rtxs.insert(id, tx);
        Ok(id as i32)
    })
}

#[no_mangle]
pub extern "C" fn rtx_close(rtx_id: u32) -> i32 {
    run_i32(|s| {
        if let Some(tx) = s.rtxs.remove(&rtx_id) {
            tx.close().map_err(|e| e.to_string())?;
        }
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn rtx_get(
    rtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
    key_ptr: *const u8,
    key_len: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let key = slice_from_raw(key_ptr, key_len);
        let Some(tx) = s.rtxs.get(&rtx_id) else {
            return Err("invalid read transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let table = match tx.open_table(def) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => return Ok(0),
            Err(e) => return Err(e.to_string()),
        };
        let found = match table.get(key).map_err(|e| e.to_string())? {
            Some(v) => {
                s.result_buf.clear();
                s.result_buf.extend_from_slice(v.value());
                1
            }
            None => 0,
        };
        Ok(found)
    })
}

#[no_mangle]
pub unsafe extern "C" fn rtx_scan(
    rtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
    start_ptr: *const u8,
    start_len: u32,
    has_start: u32,
    end_ptr: *const u8,
    end_len: u32,
    has_end: u32,
    reverse: u32,
    limit: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let start = (has_start != 0).then(|| slice_from_raw(start_ptr, start_len));
        let end = (has_end != 0).then(|| slice_from_raw(end_ptr, end_len));

        let Some(tx) = s.rtxs.get(&rtx_id) else {
            return Err("invalid read transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let table = match tx.open_table(def) {
            Ok(t) => t,
            Err(TableError::TableDoesNotExist(_)) => {
                s.result_buf.clear();
                s.result_buf.extend_from_slice(&0u32.to_le_bytes());
                return Ok(0);
            }
            Err(e) => return Err(e.to_string()),
        };
        let count = encode_scan_from_table(&table, start, end, reverse != 0, limit, &mut s.result_buf)?;
        Ok(count as i32)
    })
}

#[no_mangle]
pub extern "C" fn rtx_list_tables(rtx_id: u32) -> i32 {
    run_i32(|s| {
        let Some(tx) = s.rtxs.get(&rtx_id) else {
            return Err("invalid read transaction handle".to_string());
        };
        let iter = tx.list_tables().map_err(|e| e.to_string())?;
        s.result_buf.clear();
        s.result_buf.extend_from_slice(&0u32.to_le_bytes());
        let mut count: u32 = 0;
        for handle in iter {
            let name = handle.name().as_bytes();
            s.result_buf
                .extend_from_slice(&(name.len() as u32).to_le_bytes());
            s.result_buf.extend_from_slice(name);
            count += 1;
        }
        s.result_buf[0..4].copy_from_slice(&count.to_le_bytes());
        Ok(count as i32)
    })
}

// ---------------------------------------------------------------------------
// Write transactions (full ACID + savepoints)
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn wtx_begin(db_id: u32, durable: u32) -> i32 {
    run_i32(|s| {
        let Some(DbHandle::ReadWrite(db)) = s.dbs.get(&db_id) else {
            return Err("invalid or read-only database handle".to_string());
        };
        let mut tx = db.begin_write().map_err(|e| e.to_string())?;
        let mode = if durable != 0 {
            Durability::Immediate
        } else {
            Durability::None
        };
        tx.set_durability(mode).map_err(|e| e.to_string())?;
        let id = s.alloc_id();
        s.wtxs.insert(id, tx);
        Ok(id as i32)
    })
}

#[no_mangle]
pub extern "C" fn wtx_commit(wtx_id: u32) -> i32 {
    run_i32(|s| {
        let Some(tx) = s.wtxs.remove(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn wtx_abort(wtx_id: u32) -> i32 {
    run_i32(|s| {
        let Some(tx) = s.wtxs.remove(&wtx_id) else {
            return Ok(0);
        };
        tx.abort().map_err(|e| e.to_string())?;
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn wtx_get(
    wtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
    key_ptr: *const u8,
    key_len: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let key = slice_from_raw(key_ptr, key_len);
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let table = tx.open_table(def).map_err(|e| e.to_string())?;
        let found = match table.get(key).map_err(|e| e.to_string())? {
            Some(v) => {
                s.result_buf.clear();
                s.result_buf.extend_from_slice(v.value());
                1
            }
            None => 0,
        };
        Ok(found)
    })
}

#[no_mangle]
pub unsafe extern "C" fn wtx_set(
    wtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
    key_ptr: *const u8,
    key_len: u32,
    val_ptr: *const u8,
    val_len: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let key = slice_from_raw(key_ptr, key_len);
        let val = slice_from_raw(val_ptr, val_len);
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let mut table = tx.open_table(def).map_err(|e| e.to_string())?;
        table.insert(key, val).map_err(|e| e.to_string())?;
        Ok(0)
    })
}

#[no_mangle]
pub unsafe extern "C" fn wtx_delete(
    wtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
    key_ptr: *const u8,
    key_len: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let key = slice_from_raw(key_ptr, key_len);
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let mut table = tx.open_table(def).map_err(|e| e.to_string())?;
        let existed = table.remove(key).map_err(|e| e.to_string())?.is_some();
        Ok(i32::from(existed))
    })
}

#[no_mangle]
pub unsafe extern "C" fn wtx_delete_table(
    wtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let existed = tx.delete_table(def).map_err(|e| e.to_string())?;
        Ok(i32::from(existed))
    })
}

#[no_mangle]
pub unsafe extern "C" fn wtx_scan(
    wtx_id: u32,
    table_ptr: *const u8,
    table_len: u32,
    start_ptr: *const u8,
    start_len: u32,
    has_start: u32,
    end_ptr: *const u8,
    end_len: u32,
    has_end: u32,
    reverse: u32,
    limit: u32,
) -> i32 {
    run_i32(|s| {
        let table_name = str_from_raw(table_ptr, table_len)?;
        let start = (has_start != 0).then(|| slice_from_raw(start_ptr, start_len));
        let end = (has_end != 0).then(|| slice_from_raw(end_ptr, end_len));

        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let def: TableDefinition<&[u8], &[u8]> = TableDefinition::new(table_name);
        let table = tx.open_table(def).map_err(|e| e.to_string())?;
        let count = encode_scan_from_table(&table, start, end, reverse != 0, limit, &mut s.result_buf)?;
        Ok(count as i32)
    })
}

// ---------------------------------------------------------------------------
// Persistent savepoints (instant Copy-on-Write snapshots & rollbacks)
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn wtx_savepoint_create(wtx_id: u32) -> f64 {
    run_f64(|s| {
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let id = tx.persistent_savepoint().map_err(|e| e.to_string())?;
        Ok(id as f64)
    })
}

#[no_mangle]
pub extern "C" fn wtx_savepoint_restore(wtx_id: u32, sp_id: f64) -> i32 {
    run_i32(|s| {
        let Some(tx) = s.wtxs.get_mut(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let sp = tx
            .get_persistent_savepoint(sp_id as u64)
            .map_err(|e| e.to_string())?;
        tx.restore_savepoint(&sp).map_err(|e| e.to_string())?;
        Ok(0)
    })
}

#[no_mangle]
pub extern "C" fn wtx_savepoint_delete(wtx_id: u32, sp_id: f64) -> i32 {
    run_i32(|s| {
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let existed = tx
            .delete_persistent_savepoint(sp_id as u64)
            .map_err(|e| e.to_string())?;
        Ok(i32::from(existed))
    })
}

#[no_mangle]
pub extern "C" fn wtx_savepoint_list(wtx_id: u32) -> i32 {
    run_i32(|s| {
        let Some(tx) = s.wtxs.get(&wtx_id) else {
            return Err("invalid write transaction handle".to_string());
        };
        let iter = tx.list_persistent_savepoints().map_err(|e| e.to_string())?;
        s.result_buf.clear();
        s.result_buf.extend_from_slice(&0u32.to_le_bytes());
        let mut count: u32 = 0;
        for id in iter {
            s.result_buf.extend_from_slice(&(id as f64).to_le_bytes());
            count += 1;
        }
        s.result_buf[0..4].copy_from_slice(&count.to_le_bytes());
        Ok(count as i32)
    })
}
