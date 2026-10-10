"""Linux real-fd fixtures + explicitly modeled Darwin open dispatch, NOT native proof.

Pinned XNU f6217f891ac0bb64f3d375211650a4c1ff8ca1ea vfs_subr.c
8366-8368 rejects VLNK with O_NOFOLLOW, even with O_SYMLINK. The seam
translates accepted Darwin link flags to Linux O_PATH|O_NOFOLLOW; it does
not model the installed Mac kernel/ABI, ownership or filesystem locality.
"""
import contextlib
import errno
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
import test_native_prerequisite as core


class DarwinSymlinkOpenTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='darwin-link-contract-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name)
        (self.root/'real').mkdir()
        (self.root/'real/python').write_bytes(b'not executed')
        (self.root/'alias').symlink_to('real')
        self.p=core.load_platform()
        self.a=self.p.PosixAdapter(core.io,anchor=self.root)
        self.addCleanup(self.a.close)
        self.cap=self.a.bind_root(str(self.root),'interpreter')
        self.calls=[]; self.link_fds=[]

    @contextlib.contextmanager
    def boundary(self,native=True,after_open=None):
        # Only unavailable Darwin flag, Apple root/link UID and statfs observations.
        marker=1 << 29
        opened=os.open; stated=os.stat; fstated=os.fstat
        old_native=self.a.native
        self.a.native=native
        def anchor_stat(fd):
            value=fstated(fd)
            if native and fd==self.a.anchor.fd:
                values={k:getattr(value,k) for k in dir(value) if k.startswith('st_')}
                values['st_uid']=0  # The model's / anchor is a user-owned tmp root.
                return SimpleNamespace(**values)
            return value
        def lstat(path,*args,**kw):
            value=stated(path,*args,**kw)
            if native and stat.S_ISLNK(value.st_mode):
                values={k:getattr(value,k) for k in dir(value) if k.startswith('st_')}
                values['st_uid']=0
                return SimpleNamespace(**values)
            return value
        def dispatch(path,flags,*args,**kw):
            self.calls.append((path,flags))
            if flags & marker:
                self.assertEqual(path,'alias')
                before=stated(path,dir_fd=kw['dir_fd'],follow_symlinks=False)
                self.assertTrue(stat.S_ISLNK(before.st_mode))
                # Official predicate: no O_SYMLINK exception to VLNK/NOFOLLOW.
                if flags & os.O_NOFOLLOW:
                    raise OSError(errno.ELOOP,'modeled XNU VLNK + O_NOFOLLOW')
                self.assertEqual(flags,marker|os.O_CLOEXEC)
                fd=opened(path,os.O_PATH|os.O_NOFOLLOW|os.O_CLOEXEC,**kw)
            else:
                self.assertTrue(flags & os.O_NOFOLLOW,'ordinary/Linux no-follow retained')
                fd=opened(path,flags,*args,**kw)
            if path=='alias':
                self.link_fds.append(fd)
                self.assertTrue(stat.S_ISLNK(os.fstat(fd).st_mode))
                self.assertEqual(core.io.stamp(os.fstat(fd)),core.io.stamp(stated(path,dir_fd=kw['dir_fd'],follow_symlinks=False)))
                if after_open: after_open(fd)
            return fd
        try:
            with mock.patch.object(os,'O_SYMLINK',marker,create=True), mock.patch.object(os,'open',side_effect=dispatch), mock.patch.object(os,'stat',side_effect=lstat), mock.patch.object(os,'fstat',side_effect=anchor_stat), mock.patch.object(self.a,'_local',return_value=None):
                yield marker
        finally:
            self.a.native=old_native

    def resolve(self,caller):
        if caller=='sdk': return self.a._resolve_sdk(self.cap,'alias',8)['root']
        return self.p.resolve_interpreter(self.a,str(self.root/'alias/python'),(self.cap,))[0]

    def successful_link(self,caller,native):
        with self.boundary(native) as marker:
            try: node=self.resolve(caller)
            except OSError as error: self.fail('link-body descriptor must open: '+str(error.errno))
            self.assertEqual(node.path,self.root/'real')
            self.assertEqual(len(self.link_fds),1)
            flag=next(flags for path,flags in self.calls if path=='alias')
            self.assertEqual(flag,(marker if native else os.O_PATH|os.O_NOFOLLOW)|os.O_CLOEXEC)
            self.assertEqual(os.readlink('alias',dir_fd=self.cap.fd),'real')
            self.assertEqual(self.a.sdk_links[0][2],self.link_fds[0])
            self.assertIs(self.cap.owner,self.a)
        fd=self.link_fds[0]
        self.a.close()
        with self.assertRaises(OSError): os.fstat(fd)
        self.assertTrue(self.a.closed)

    def test_darwin_sdk_link_body_descriptor(self):
        self.successful_link('sdk',True)

    def test_darwin_interpreter_link_body_descriptor(self):
        self.successful_link('interpreter',True)

    def wrong_descriptor_type(self,caller):
        fstat=os.fstat
        with contextlib.ExitStack() as patches:
            def change(fd):
                original=fstat(fd)
                values={k:getattr(original,k) for k in dir(original) if k.startswith('st_')}
                values['st_mode']=stat.S_IFREG|0o600
                # Preserve non-mode identity fields: stamp already includes st_mode.
                patches.enter_context(mock.patch.object(os,'fstat',side_effect=lambda n: SimpleNamespace(**values) if n==fd else fstat(n)))
            with self.boundary(after_open=change):
                with self.assertRaises(core.io.Stop) as caught: self.resolve(caller)
                self.assertEqual(caught.exception.reason,'IDENTITY_CHANGED' if caller=='sdk' else 'BOOTSTRAP_UNPROVEN')
        self.a.close()
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])

    def test_sdk_rejects_nonlink_descriptor_even_with_same_inode(self):
        self.wrong_descriptor_type('sdk')

    def test_interpreter_rejects_nonlink_descriptor_even_with_same_inode(self):
        self.wrong_descriptor_type('interpreter')

    def test_linux_sdk_link_body_descriptor(self):
        self.successful_link('sdk',False)

    def test_linux_interpreter_link_body_descriptor(self):
        self.successful_link('interpreter',False)

    def test_native_ordinary_read_create_and_directories_keep_nofollow(self):
        (self.root/'private').mkdir(mode=0o700)  # User-owned child, not the model's /.
        with self.boundary():
            node=self.a.bind_root(str(self.root/'real'),'interpreter')
            self.assertEqual(self.p.resolve_interpreter(self.a,str(self.root/'real/python'),(self.cap,)),(node,'python'))
            fd=self.a.open_read(node,'python')
            self.assertEqual(os.read(fd,32),b'not executed')
            core.io.close_fd(self.a,fd)
            parent=self.a.bind_root(str(self.root/'private'),'private-parent')
            out=self.a.new_output(parent,'output')
            fd=self.a.create(out,'new')
            core.io.close_fd(self.a,fd)
            self.assertFalse(self.link_fds)
            self.assertTrue(self.calls)
            for path,flags in self.calls: self.assertTrue(flags & os.O_NOFOLLOW)
            with self.assertRaises(core.io.Stop): self.a.bind_root(str(self.root/'alias'),'interpreter')
            (self.root/'real/alias-file').symlink_to('python')
            with self.assertRaises(core.io.Stop): self.a.open_read(node,'alias-file')

    def test_native_sdk_target_escape_refused_and_original_fd_closed(self):
        (self.root/'alias').unlink(); (self.root/'alias').symlink_to('../outside')
        with self.boundary():
            with self.assertRaises(core.io.Stop) as caught: self.resolve('sdk')
            self.assertEqual(caught.exception.reason,'PATH_REFUSED')
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])

    def test_native_interpreter_target_escape_refused_and_owner_retained(self):
        (self.root/'alias').unlink(); (self.root/'alias').symlink_to('../outside')
        with self.boundary():
            with self.assertRaises(core.io.Stop) as caught: self.resolve('interpreter')
            self.assertEqual(caught.exception.reason,'BOOTSTRAP_UNPROVEN')
            self.assertEqual(self.a.sdk_links[0][2],self.link_fds[0])
        self.a.close()
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])

    def test_native_sdk_replaced_link_is_not_cached_success(self):
        with self.boundary():
            self.resolve('sdk')
            (self.root/'alias').rename(self.root/'old-alias')
            (self.root/'alias').symlink_to('real')
            with self.assertRaises(core.io.Stop) as caught: self.resolve('sdk')
            self.assertEqual(caught.exception.reason,'IDENTITY_CHANGED')
        self.a.close()
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])

    def test_native_interpreter_replaced_link_is_not_cached_success(self):
        with self.boundary():
            self.resolve('interpreter')
            (self.root/'alias').rename(self.root/'old-alias')
            (self.root/'alias').symlink_to('real')
            with self.assertRaises(core.io.Stop) as caught: self.resolve('interpreter')
            self.assertEqual(caught.exception.reason,'IDENTITY_CHANGED')
        self.a.close()
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])

    def test_native_sdk_readlink_error_preserves_exception_and_closes(self):
        error=OSError(errno.EIO,'fixture error')
        with self.boundary(),mock.patch.object(os,'readlink',side_effect=error):
            with self.assertRaises(OSError) as caught: self.resolve('sdk')
            self.assertIs(caught.exception,error)
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])

    def test_native_interpreter_readlink_error_retains_original_owner(self):
        error=OSError(errno.EIO,'fixture error')
        with self.boundary(),mock.patch.object(os,'readlink',side_effect=error):
            with self.assertRaises(OSError) as caught: self.resolve('interpreter')
            self.assertIs(caught.exception,error)
            self.assertEqual(self.a.sdk_links[0][2],self.link_fds[0])
        self.a.close()
        with self.assertRaises(OSError): os.fstat(self.link_fds[0])


if __name__=='__main__': unittest.main()
