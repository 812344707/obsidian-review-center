//! Sequential execution adapter for the pinned fsrs 6.6.2 WASI build.
//! Only dispatch changes: all FSRS training, evaluation and simulation math is upstream.
//! The desktop Node worker supplies isolation and cancellation; nested OS threads are unnecessary.
pub fn spawn<F>(operation: F) where F: FnOnce() + Send + 'static { operation(); }
pub mod iter {
    pub trait IntoParallelIterator: IntoIterator + Sized {
        fn into_par_iter(self) -> Self::IntoIter { self.into_iter() }
    }
    impl<T: IntoIterator> IntoParallelIterator for T {}
    pub trait ParallelIterator: Iterator {}
    impl<T: Iterator> ParallelIterator for T {}
}
